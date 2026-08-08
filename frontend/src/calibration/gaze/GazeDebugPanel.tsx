import { useEffect, useRef } from 'react'
import type { GazeResult } from 'webeyetrack'
import { GAZE_VIDEO_ID, type GazeTracker } from './useGazeTracker'

// Development instrumentation: what the tracker is ACTUALLY seeing, drawn
// next to what it concluded. Two stacked canvases in the bottom-left corner:
//
//   1. the live camera frame with the face mesh, the estimated head pose (a
//      wireframe box + axes from faceRt), and the two eyes ringed;
//   2. a plan view of the screen plane - the viewport rectangle, the nine
//      calibration targets, a trail of recent gaze points, and where the
//      current sample landed relative to the head.
//
// The second panel is the one that earns its keep: a gaze blob sitting in the
// wrong place looks identical whether the face is being lost, the head has
// drifted out of the calibrated pose, or the affine fit is simply bad - and
// those three have completely different fixes. Panel 1 rules out the first,
// the trail-vs-targets spread in panel 2 separates the other two.
//
// Everything here draws from refs inside one requestAnimationFrame loop and
// never triggers a React render.

const PANEL_W = 320
const CAM_H = 180
const PLANE_H = 176

// How many recent gaze samples the plane view keeps as a trail. ~10 samples
// per second (useGazeTracker's MIN_FRAME_INTERVAL_MS), so this is the last
// ~12 seconds - long enough to show the spread of a fixation, short enough
// that the cloud still tracks where you are looking now.
const TRAIL_LENGTH = 120

const COLOR = {
  mesh: 'rgba(255, 255, 255, 0.55)',
  box: '#3b9dff',
  eyeA: '#22d3ee',
  eyeB: '#facc15',
  axisX: '#ef4444',
  axisY: '#22c55e',
  axisZ: '#3b82f6',
  screen: '#facc15',
  diagonal: 'rgba(250, 204, 21, 0.35)',
  target: '#fb923c',
  trail: 'rgba(255, 255, 255, 0.5)',
  head: '#f472b6',
  ray: '#22d3ee',
  dim: 'rgba(255, 255, 255, 0.35)',
}

// MediaPipe face-mesh landmark indices. Eye corners rather than the iris
// points, because the iris refinement is not guaranteed to be enabled on the
// bundled .task model - these four always exist.
const EYE_A = { outer: 33, inner: 133 }
const EYE_B = { outer: 263, inner: 362 }
// Face width, used as the scale unit for the head box below.
const CHEEK_L = 234
const CHEEK_R = 454
const NOSE_TIP = 4

type Vec3 = [number, number, number]

// faceRt is MediaPipe's facialTransformationMatrix passed straight through
// (see webeyetrack's WebEyeTrack.step), and its 16 floats are documented as
// column-major - the layout three.js's Matrix4.fromArray expects - so element
// (row, col) is data[col * 4 + row] and the translation sits at 12..14.
//
// Not asserted, though: webeyetrack's own translateMatrix reads the same
// array as row-major (data[r * columns + s]), which is self-consistent for it
// because it works in the transposed, row-vector convention throughout - but
// it means the layout is worth checking rather than assuming. Whichever
// interpretation is right, the translation column is the giveaway: it is a
// position in centimetres (tens), while the other candidate slot is the
// matrix's bottom row, which is exactly [0, 0, 0, 1]. So pick the layout by
// looking, and transpose the rotation if the array turns out to be row-major.
function rotationFrom(faceRt: GazeResult['faceRt']): Vec3[] | null {
  const d = faceRt?.data
  if (!d || d.length < 16) return null
  const columnMajor =
    Math.abs(d[12]) + Math.abs(d[13]) + Math.abs(d[14]) >= Math.abs(d[3]) + Math.abs(d[7]) + Math.abs(d[11])
  return columnMajor
    ? [
        [d[0], d[4], d[8]],
        [d[1], d[5], d[9]],
        [d[2], d[6], d[10]],
      ]
    : [
        [d[0], d[1], d[2]],
        [d[4], d[5], d[6]],
        [d[8], d[9], d[10]],
      ]
}

function rotate(r: Vec3[], p: Vec3): Vec3 {
  return [
    r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2],
    r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2],
    r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2],
  ]
}

// The head box corners in face-local units (1 = face width), ordered as two
// quads - back face then front face - so the edge list below can pair them up.
const BOX_CORNERS: Vec3[] = [
  [-0.62, -0.85, -0.55],
  [0.62, -0.85, -0.55],
  [0.62, 0.85, -0.55],
  [-0.62, 0.85, -0.55],
  [-0.62, -0.85, 0.55],
  [0.62, -0.85, 0.55],
  [0.62, 0.85, 0.55],
  [-0.62, 0.85, 0.55],
]
const BOX_EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
]

function GazeDebugPanel({
  resultRef,
  tracker,
}: {
  // Written by App's gaze callback on every sample, corrected normPog
  // included - i.e. exactly the sample the blob is driven from.
  resultRef: React.RefObject<GazeResult | null>
  tracker: GazeTracker
}) {
  const camRef = useRef<HTMLCanvasElement | null>(null)
  const planeRef = useRef<HTMLCanvasElement | null>(null)
  const readoutRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    const cam = camRef.current
    const plane = planeRef.current
    if (!cam || !plane) return
    const camCtx = cam.getContext('2d')
    const planeCtx = plane.getContext('2d')
    if (!camCtx || !planeCtx) return

    // Backing store at device resolution, drawing in CSS pixels. A 1px mesh
    // dot on a HiDPI screen is otherwise a blurry 2px smear, which is the
    // difference between seeing the landmark scatter and not.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    for (const [canvas, height] of [
      [cam, CAM_H],
      [plane, PLANE_H],
    ] as const) {
      canvas.width = PANEL_W * dpr
      canvas.height = height * dpr
      canvas.getContext('2d')?.scale(dpr, dpr)
    }

    const trail: [number, number][] = []
    let lastSeen: GazeResult | null = null
    let sampleCount = 0
    let fpsWindowStart = performance.now()
    let fps = 0
    let frameId = 0

    const drawCamera = (result: GazeResult | null) => {
      camCtx.fillStyle = '#000'
      camCtx.fillRect(0, 0, PANEL_W, CAM_H)

      // Letterbox the frame rather than stretching it: the landmarks are
      // normalized to the video's own aspect, so any distortion applied to
      // the image has to be applied to them identically or the mesh slides
      // off the face.
      const video = document.getElementById(GAZE_VIDEO_ID) as HTMLVideoElement | null
      const vw = video?.videoWidth || 4
      const vh = video?.videoHeight || 3
      const scale = Math.min(PANEL_W / vw, CAM_H / vh)
      const dw = vw * scale
      const dh = vh * scale
      const dx = (PANEL_W - dw) / 2
      const dy = (CAM_H - dh) / 2
      if (video && video.videoWidth > 0) {
        camCtx.drawImage(video, dx, dy, dw, dh)
      }

      const marks = result?.facialLandmarks
      if (!marks || marks.length === 0) {
        camCtx.fillStyle = COLOR.dim
        camCtx.font = '11px ui-monospace, monospace'
        camCtx.fillText('no face', 8, CAM_H - 8)
        return
      }
      const at = (i: number): [number, number] => [dx + marks[i].x * dw, dy + marks[i].y * dh]

      camCtx.fillStyle = COLOR.mesh
      for (const m of marks) {
        camCtx.fillRect(dx + m.x * dw - 0.5, dy + m.y * dh - 0.5, 1.2, 1.2)
      }

      // Eyes. Radius from the eye's own corner-to-corner width so the ring
      // stays sized to the face as it moves nearer and further.
      for (const [eye, color] of [
        [EYE_A, COLOR.eyeA],
        [EYE_B, COLOR.eyeB],
      ] as const) {
        const [ox, oy] = at(eye.outer)
        const [ix, iy] = at(eye.inner)
        const r = Math.max(5, Math.hypot(ix - ox, iy - oy) * 0.55)
        camCtx.strokeStyle = color
        camCtx.lineWidth = 1.5
        camCtx.beginPath()
        camCtx.arc((ox + ix) / 2, (oy + iy) / 2, r, 0, Math.PI * 2)
        camCtx.stroke()
      }

      const rot = result ? rotationFrom(result.faceRt) : null
      if (!rot) return
      const [lx, ly] = at(CHEEK_L)
      const [rx, ry] = at(CHEEK_R)
      const faceWidth = Math.hypot(rx - lx, ry - ly)
      const cx = (lx + rx) / 2
      const cy = (ly + ry) / 2

      // Weak perspective: rotate into camera space, then scale each vertex by
      // its own depth. Enough to make the box read as 3D without needing the
      // camera intrinsics, which webeyetrack keeps private.
      const project = (p: Vec3): [number, number] => {
        const c = rotate(rot, p)
        const persp = 1 + c[2] * 0.28
        return [cx + faceWidth * persp * c[0], cy - faceWidth * persp * c[1]]
      }

      camCtx.strokeStyle = COLOR.box
      camCtx.lineWidth = 1.25
      camCtx.beginPath()
      for (const [a, b] of BOX_EDGES) {
        const [ax, ay] = project(BOX_CORNERS[a])
        const [bx, by] = project(BOX_CORNERS[b])
        camCtx.moveTo(ax, ay)
        camCtx.lineTo(bx, by)
      }
      camCtx.stroke()

      // Head axes, drawn from the nose so they read as attached to the face
      // rather than floating at the box centre.
      const [nx, ny] = at(NOSE_TIP)
      const axisLen = 0.55
      for (const [axis, color] of [
        [[axisLen, 0, 0], COLOR.axisX],
        [[0, axisLen, 0], COLOR.axisY],
        [[0, 0, axisLen], COLOR.axisZ],
      ] as [Vec3, string][]) {
        const c = rotate(rot, axis)
        camCtx.strokeStyle = color
        camCtx.lineWidth = 2
        camCtx.beginPath()
        camCtx.moveTo(nx, ny)
        camCtx.lineTo(nx + faceWidth * c[0], ny - faceWidth * c[1])
        camCtx.stroke()
      }
    }

    const drawPlane = (result: GazeResult | null) => {
      planeCtx.fillStyle = '#000'
      planeCtx.fillRect(0, 0, PANEL_W, PLANE_H)

      // The viewport rectangle is inset, so samples that land off-screen
      // (the interesting failure) are still visible instead of clipped away.
      const inset = 30
      const rx = inset
      const ry = inset * 0.55
      const rw = PANEL_W - inset * 2
      const rh = PLANE_H - inset * 1.1
      const toPx = (n: number, m: number): [number, number] => [rx + (n + 0.5) * rw, ry + (m + 0.5) * rh]

      planeCtx.strokeStyle = COLOR.diagonal
      planeCtx.lineWidth = 1
      planeCtx.beginPath()
      planeCtx.moveTo(rx, ry)
      planeCtx.lineTo(rx + rw, ry + rh)
      planeCtx.moveTo(rx + rw, ry)
      planeCtx.lineTo(rx, ry + rh)
      planeCtx.stroke()

      planeCtx.strokeStyle = COLOR.screen
      planeCtx.lineWidth = 1.5
      planeCtx.strokeRect(rx, ry, rw, rh)

      // Where the nine dots were, in the same space - the reference the
      // trail below should be clustering around.
      planeCtx.strokeStyle = COLOR.target
      planeCtx.lineWidth = 1
      for (const pair of tracker.getCalibrationPairs()) {
        const [px, py] = toPx(pair.target[0], pair.target[1])
        planeCtx.beginPath()
        planeCtx.moveTo(px - 3, py)
        planeCtx.lineTo(px + 3, py)
        planeCtx.moveTo(px, py - 3)
        planeCtx.lineTo(px, py + 3)
        planeCtx.stroke()
      }

      // Trail: oldest faintest, so the direction of travel is readable.
      trail.forEach(([tx, ty], i) => {
        const [px, py] = toPx(tx, ty)
        planeCtx.fillStyle = `rgba(255, 255, 255, ${0.08 + 0.5 * (i / Math.max(1, trail.length - 1))})`
        planeCtx.fillRect(px - 1, py - 1, 2, 2)
      })

      // Head position from faceOrigin3D (centimetres from the camera).
      // Divided by a plausible half-range rather than anything measured -
      // this marker is for watching DRIFT, not for absolute placement.
      let head: [number, number] | null = null
      const origin = result?.faceOrigin3D
      if (origin && origin.length >= 2 && Number.isFinite(origin[0])) {
        head = toPx(Math.max(-0.9, Math.min(0.9, origin[0] / 30)), Math.max(-0.9, Math.min(0.9, origin[1] / 30)))
        planeCtx.strokeStyle = COLOR.head
        planeCtx.lineWidth = 1.5
        planeCtx.beginPath()
        planeCtx.moveTo(head[0] - 5, head[1] - 5)
        planeCtx.lineTo(head[0] + 5, head[1] + 5)
        planeCtx.moveTo(head[0] + 5, head[1] - 5)
        planeCtx.lineTo(head[0] - 5, head[1] + 5)
        planeCtx.stroke()
        planeCtx.fillStyle = COLOR.head
        planeCtx.font = '9px ui-monospace, monospace'
        planeCtx.fillText('head', head[0] + 8, head[1] - 6)
      }

      if (result && result.gazeState === 'open') {
        const [gx, gy] = toPx(result.normPog[0], result.normPog[1])
        if (head) {
          planeCtx.strokeStyle = COLOR.ray
          planeCtx.lineWidth = 1.5
          planeCtx.beginPath()
          planeCtx.moveTo(head[0], head[1])
          planeCtx.lineTo(gx, gy)
          planeCtx.stroke()
        }
        planeCtx.strokeStyle = COLOR.screen
        planeCtx.lineWidth = 2
        planeCtx.beginPath()
        planeCtx.arc(gx, gy, 9, 0, Math.PI * 2)
        planeCtx.stroke()
      }
    }

    const renderFrame = () => {
      const result = resultRef.current

      // Sample identity changes only when a new inference lands, so this is
      // the tracker's real inference rate - not the display frame rate.
      if (result && result !== lastSeen) {
        lastSeen = result
        sampleCount += 1
        if (result.gazeState === 'open') {
          trail.push([result.normPog[0], result.normPog[1]])
          if (trail.length > TRAIL_LENGTH) trail.shift()
        }
      }
      const now = performance.now()
      if (now - fpsWindowStart >= 1000) {
        fps = (sampleCount * 1000) / (now - fpsWindowStart)
        sampleCount = 0
        fpsWindowStart = now
      }

      drawCamera(result)
      drawPlane(result)

      const readout = readoutRef.current
      if (readout) {
        const pog = result?.normPog
        readout.textContent = [
          `state  ${result ? result.gazeState : '—'}`,
          `rate   ${fps.toFixed(1)}/s`,
          `pog    ${pog ? `${pog[0].toFixed(3)}, ${pog[1].toFixed(3)}` : '—'}`,
          `calib  ${tracker.getCalibrationPairs().length} pts${tracker.isCorrectionFromFile() ? ' (file)' : ''}`,
        ].join('\n')
      }
    }

    // Drawn once synchronously before the loop starts. requestAnimationFrame
    // does not fire while the tab is hidden or otherwise not compositing, so
    // without this the panel can sit completely blank - indistinguishable
    // from "the tracker died", which is the exact confusion it exists to
    // prevent.
    renderFrame()
    const animate = () => {
      frameId = window.requestAnimationFrame(animate)
      renderFrame()
    }
    frameId = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(frameId)
  }, [resultRef, tracker])

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed bottom-4 left-4 z-40 w-[320px] overflow-hidden rounded-lg border border-white/15 bg-black/80 shadow-lg"
    >
      <canvas ref={camRef} style={{ width: PANEL_W, height: CAM_H, display: 'block' }} />
      <canvas
        ref={planeRef}
        style={{ width: PANEL_W, height: PLANE_H, display: 'block' }}
        className="border-t border-white/10"
      />
      <pre
        ref={readoutRef}
        className="m-0 border-t border-white/10 px-3 py-2 font-mono text-[10px] leading-[1.5] text-white/70"
      />
      <p className="m-0 px-3 pb-2 font-mono text-[10px] text-white/40">F8 = hide debug view</p>
    </div>
  )
}

export default GazeDebugPanel
