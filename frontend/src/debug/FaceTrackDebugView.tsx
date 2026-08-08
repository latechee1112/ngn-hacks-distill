import { useEffect, useRef } from 'react'
import type { GazeResult } from 'webeyetrack'
import { GAZE_VIDEO_ID, type GazeTracker } from '../calibration/gaze/useGazeTracker'

// The left column of the facetrack debug page: several views of the same
// instant, so a bad gaze estimate can be attributed to a stage rather than
// guessed at.
//
//   raw       - the camera frame, untouched. Framing, exposure and motion
//     |         blur are judged here, and only here: the annotated view
//     |         covers the face with the very pixels you would be judging.
//   annotated - the same frame with what the tracker extracted from it: the
//               face mesh, the eyes, the head pose box and axes, and a bar
//               out of each eye toward the reported gaze.
//   eyes      - a crop around both eyes, blown up to fill the panel. At the
//               scale of the two views above, an eye is a few dozen pixels
//               across and its landmarks are an indistinct smudge - which is
//               a problem, because the eye patch is what the gaze model
//               actually consumes, so lid landmarks sitting slightly wrong
//               is a failure worth being able to SEE rather than infer.
//   plane     - the screen, seen head-on: the viewport rectangle, the
//               calibration targets, a trail of recent samples, and the same
//               two eye bars arriving at the current gaze point.
//
// Everything draws from refs inside one requestAnimationFrame loop; nothing
// here triggers a React render.

// How many recent gaze samples the plane view keeps as a trail. ~10 samples
// per second (useGazeTracker's MIN_FRAME_INTERVAL_MS), so this is the last
// ~12 seconds - long enough to show the spread of a fixation, short enough
// that the cloud still tracks where you are looking now.
const TRAIL_LENGTH = 120

// Scale for the plane view's head marker. faceOrigin3D is in centimetres from
// the camera, and +-30cm of lateral movement is about as far as you get while
// still being tracked at all, so it maps the panel's full width. Both of
// these are for RELATIVE reading - watching the head drift, and seeing the
// eyes as two distinct origins - not for absolute placement.
const HEAD_RANGE_CM = 30
const IPD_CM = 6.3

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
  head: '#f472b6',
  dim: 'rgba(255, 255, 255, 0.4)',
}

// MediaPipe face-mesh landmark indices. Eye corners rather than the iris
// points, because the iris refinement is not guaranteed to be enabled on the
// bundled .task model - these four always exist.
const EYE_A = { outer: 33, inner: 133 }
const EYE_B = { outer: 263, inner: 362 }
// Corners plus upper and lower lids, for measuring the crop the eye view
// zooms into - corners alone give a region with no height.
const EYE_REGION = [33, 133, 159, 145, 263, 362, 386, 374]
// Iris centres. Present only when the model was built with landmark
// refinement (478 points rather than 468), hence the length check at the
// call site - worth drawing when they exist, since at this zoom a mis-fitted
// iris is obvious and it is the single most gaze-relevant landmark there is.
const IRIS_A = 468
const IRIS_B = 473
const REFINED_LANDMARK_COUNT = 478
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

interface Size {
  w: number
  h: number
}

// Where the (letterboxed, never stretched) video frame lands inside a canvas.
// The landmarks are normalized to the video's own aspect ratio, so any fit
// applied to the image has to be applied to them identically or the mesh
// slides off the face.
function videoFit(video: HTMLVideoElement | null, size: Size) {
  const vw = video?.videoWidth || 4
  const vh = video?.videoHeight || 3
  const scale = Math.min(size.w / vw, size.h / vh)
  const dw = vw * scale
  const dh = vh * scale
  return { dx: (size.w - dw) / 2, dy: (size.h - dh) / 2, dw, dh }
}

interface EyeMark {
  x: number
  y: number
  r: number
}

// The two eyes in whichever panel space `at` maps into, so the annotated and
// zoomed views describe the same eyes the same way. Radius comes from the
// eye's own corner-to-corner width, so a ring stays sized to the face as it
// moves nearer and further.
//
// Ordered by position rather than by landmark index, so cyan and yellow stay
// put instead of swapping if a feed ever arrives already mirrored. Descending
// because the camera panels draw inside a mirror transform: the eye with the
// LARGEST image x is the one that ends up on the left of the panel, and
// cyan-on-the-left is the convention the screen plane panel matches.
function eyeMarks(at: (i: number) => [number, number]): EyeMark[] {
  return ([EYE_A, EYE_B] as const)
    .map((eye) => {
      const [ox, oy] = at(eye.outer)
      const [ix, iy] = at(eye.inner)
      return {
        x: (ox + ix) / 2,
        y: (oy + iy) / 2,
        r: Math.max(4, Math.hypot(ix - ox, iy - oy) * 0.55),
      }
    })
    .sort((a, b) => b.x - a.x)
}

const EYE_COLORS = [COLOR.eyeA, COLOR.eyeB]

// One bar out of each eye, pointing where this sample says you are looking.
// Computed in IMAGE space, where the frame arrives unmirrored - looking at
// the right of the screen turns your eyes toward the left of the raw frame,
// hence the negated x. The camera panels then draw this inside their mirror
// transform, which flips it back, so on screen the bar leaves the eye toward
// the side actually being looked at.
//
// Length grows with how far off-centre the gaze is, so looking straight down
// the camera axis shortens the bars to nothing rather than leaving them
// pointing somewhere arbitrary - the same foreshortening a real ray toward
// the viewer would have. `unit` is whatever length means "one face" in the
// panel being drawn into, so the bars stay proportionate at any zoom.
function drawGazeBars(
  ctx: CanvasRenderingContext2D,
  eyes: EyeMark[],
  result: GazeResult | null,
  unit: number,
) {
  if (!result || result.gazeState !== 'open') return
  const gx = -result.normPog[0]
  const gy = result.normPog[1]
  const mag = Math.hypot(gx, gy)
  if (mag <= 0.02) return
  const ux = gx / mag
  const uy = gy / mag
  const len = unit * (0.3 + 2.4 * mag)
  ctx.lineCap = 'round'
  ctx.lineWidth = 3
  eyes.forEach((eye, i) => {
    ctx.strokeStyle = EYE_COLORS[i]
    ctx.beginPath()
    // Started at the ring's edge, not its centre, so the bar reads as leaving
    // the eye instead of skewering it.
    ctx.moveTo(eye.x + ux * eye.r, eye.y + uy * eye.r)
    ctx.lineTo(eye.x + ux * len, eye.y + uy * len)
    ctx.stroke()
  })
  ctx.lineCap = 'butt'
}

function FaceTrackDebugView({
  resultRef,
  tracker,
  showAnnotationsRef,
}: {
  // Written by the page's gaze callback on every sample, corrected normPog
  // included - i.e. exactly the sample the rest of the extension acts on.
  resultRef: React.RefObject<GazeResult | null>
  tracker: GazeTracker
  // A ref rather than a prop value: flipping it must not re-render, because a
  // re-render restarts the draw effect below and takes the gaze trail - the
  // one thing you were watching - with it.
  showAnnotationsRef: React.RefObject<boolean>
}) {
  const rawRef = useRef<HTMLCanvasElement | null>(null)
  const annotatedRef = useRef<HTMLCanvasElement | null>(null)
  const eyeZoomRef = useRef<HTMLCanvasElement | null>(null)
  const planeRef = useRef<HTMLCanvasElement | null>(null)
  const statusRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const raw = rawRef.current
    const annotated = annotatedRef.current
    const eyeZoom = eyeZoomRef.current
    const plane = planeRef.current
    if (!raw || !annotated || !eyeZoom || !plane) return
    const rawCtx = raw.getContext('2d')
    const annCtx = annotated.getContext('2d')
    const eyeCtx = eyeZoom.getContext('2d')
    const planeCtx = plane.getContext('2d')
    if (!rawCtx || !annCtx || !eyeCtx || !planeCtx) return

    // These canvases are laid out by flexbox, so their pixel size is only
    // known at runtime and changes with the window. The backing store is kept
    // at device resolution and the drawing code works in CSS pixels - a 1px
    // mesh dot on a HiDPI screen is otherwise a blurry 2px smear, which is
    // the difference between seeing the landmark scatter and not.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const sizes = new Map<HTMLCanvasElement, Size>()
    const measure = (canvas: HTMLCanvasElement) => {
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width))
      const h = Math.max(1, Math.round(rect.height))
      const prev = sizes.get(canvas)
      if (prev && prev.w === w && prev.h === h) return
      sizes.set(canvas, { w, h })
      canvas.width = w * dpr
      canvas.height = h * dpr
      // Resizing the backing store resets the context, transform included,
      // so the scale has to be reapplied here rather than set up once.
      canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const canvases = [raw, annotated, eyeZoom, plane]
    canvases.forEach(measure)
    const observer = new ResizeObserver(() => canvases.forEach(measure))
    canvases.forEach((c) => observer.observe(c))

    const trail: [number, number][] = []
    let lastSeen: GazeResult | null = null
    let sampleCount = 0
    let fpsWindowStart = performance.now()
    let fps = 0
    let frameId = 0

    const label = (ctx: CanvasRenderingContext2D, text: string) => {
      ctx.fillStyle = COLOR.dim
      ctx.font = '11px ui-monospace, monospace'
      ctx.fillText(text, 8, 16)
    }

    const currentVideo = () => document.getElementById(GAZE_VIDEO_ID) as HTMLVideoElement | null

    // The webcam hands over an UNMIRRORED frame - you as others see you - and
    // a debug view is something you watch while moving your own head, so
    // unmirrored means every correction you make goes the wrong way. Flipping
    // the whole panel (image and annotations together, inside one transform)
    // rather than just the image is what keeps the two in register: the mesh,
    // the box and the gaze bars are all computed in image space and come out
    // mirrored with it, so the bars still leave the eyes toward the side of
    // the screen being looked at.
    //
    // Callers must draw text OUTSIDE this, or it comes out backwards, and
    // must not `return` from inside the save/restore pair - hence the overlay
    // bodies below being their own functions.
    const mirrored = (ctx: CanvasRenderingContext2D, size: Size, draw: () => void) => {
      ctx.save()
      ctx.translate(size.w, 0)
      ctx.scale(-1, 1)
      draw()
      ctx.restore()
    }

    const drawRaw = () => {
      const size = sizes.get(raw)
      if (!size) return
      rawCtx.fillStyle = '#000'
      rawCtx.fillRect(0, 0, size.w, size.h)
      const video = currentVideo()
      if (video && video.videoWidth > 0) {
        const { dx, dy, dw, dh } = videoFit(video, size)
        mirrored(rawCtx, size, () => rawCtx.drawImage(video, dx, dy, dw, dh))
      } else {
        rawCtx.fillStyle = COLOR.dim
        rawCtx.font = '12px ui-monospace, monospace'
        rawCtx.fillText('no camera frame', 12, size.h / 2)
      }
      label(rawCtx, 'raw')
    }

    const drawAnnotated = (result: GazeResult | null) => {
      const size = sizes.get(annotated)
      if (!size) return
      annCtx.fillStyle = '#000'
      annCtx.fillRect(0, 0, size.w, size.h)
      const video = currentVideo()
      const fit = videoFit(video, size)
      const marks = result?.facialLandmarks
      mirrored(annCtx, size, () => {
        if (video && video.videoWidth > 0) {
          annCtx.drawImage(video, fit.dx, fit.dy, fit.dw, fit.dh)
        }
        if (marks && marks.length > 0 && showAnnotationsRef.current) {
          drawFaceOverlay(marks, result, fit)
        }
      })

      label(annCtx, `annotated${showAnnotationsRef.current ? '' : ' (overlay off — A)'}`)
      if (!marks || marks.length === 0) {
        annCtx.fillStyle = COLOR.dim
        annCtx.font = '12px ui-monospace, monospace'
        annCtx.fillText('no face', 12, size.h - 12)
      }
    }

    // Drawn in image space, inside drawAnnotated's mirror transform.
    const drawFaceOverlay = (
      marks: NonNullable<GazeResult['facialLandmarks']>,
      result: GazeResult | null,
      { dx, dy, dw, dh }: { dx: number; dy: number; dw: number; dh: number },
    ) => {
      const at = (i: number): [number, number] => [dx + marks[i].x * dw, dy + marks[i].y * dh]

      annCtx.fillStyle = COLOR.mesh
      for (const m of marks) {
        annCtx.fillRect(dx + m.x * dw - 0.5, dy + m.y * dh - 0.5, 1.2, 1.2)
      }

      const eyes = eyeMarks(at)
      eyes.forEach((eye, i) => {
        annCtx.strokeStyle = EYE_COLORS[i]
        annCtx.lineWidth = 1.5
        annCtx.beginPath()
        annCtx.arc(eye.x, eye.y, eye.r, 0, Math.PI * 2)
        annCtx.stroke()
      })

      const [lx, ly] = at(CHEEK_L)
      const [rx, ry] = at(CHEEK_R)
      const faceWidth = Math.hypot(rx - lx, ry - ly)
      const cx = (lx + rx) / 2
      const cy = (ly + ry) / 2

      drawGazeBars(annCtx, eyes, result, faceWidth)

      const rot = result ? rotationFrom(result.faceRt) : null
      if (!rot) return

      // Weak perspective: rotate into camera space, then scale each vertex by
      // its own depth. Enough to make the box read as 3D without needing the
      // camera intrinsics, which webeyetrack keeps private.
      const project = (p: Vec3): [number, number] => {
        const c = rotate(rot, p)
        const persp = 1 + c[2] * 0.28
        return [cx + faceWidth * persp * c[0], cy - faceWidth * persp * c[1]]
      }

      annCtx.strokeStyle = COLOR.box
      annCtx.lineWidth = 1.25
      annCtx.beginPath()
      for (const [a, b] of BOX_EDGES) {
        const [ax, ay] = project(BOX_CORNERS[a])
        const [bx, by] = project(BOX_CORNERS[b])
        annCtx.moveTo(ax, ay)
        annCtx.lineTo(bx, by)
      }
      annCtx.stroke()

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
        annCtx.strokeStyle = color
        annCtx.lineWidth = 2
        annCtx.beginPath()
        annCtx.moveTo(nx, ny)
        annCtx.lineTo(nx + faceWidth * c[0], ny - faceWidth * c[1])
        annCtx.stroke()
      }
    }

    const drawEyes = (result: GazeResult | null) => {
      const size = sizes.get(eyeZoom)
      if (!size) return
      eyeCtx.fillStyle = '#000'
      eyeCtx.fillRect(0, 0, size.w, size.h)
      const video = currentVideo()
      const marks = result?.facialLandmarks
      if (!video || video.videoWidth === 0 || !marks || marks.length === 0) {
        eyeCtx.fillStyle = COLOR.dim
        eyeCtx.font = '12px ui-monospace, monospace'
        eyeCtx.fillText('no face', 12, size.h / 2)
        label(eyeCtx, 'eyes')
        return
      }

      // Crop, in video pixels, around every eye landmark, padded outward so
      // the brow and cheek give the eye somewhere to sit - a crop clamped to
      // the lids alone reads as an anatomy diagram rather than a face.
      const vw = video.videoWidth
      const vh = video.videoHeight
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const i of EYE_REGION) {
        const m = marks[i]
        if (!m) continue
        minX = Math.min(minX, m.x * vw)
        maxX = Math.max(maxX, m.x * vw)
        minY = Math.min(minY, m.y * vh)
        maxY = Math.max(maxY, m.y * vh)
      }
      if (!Number.isFinite(minX) || maxX <= minX) return
      const pad = (maxX - minX) * 0.18
      let sx = minX - pad
      let sy = minY - pad
      let sw = maxX - minX + pad * 2
      let sh = maxY - minY + pad * 2

      // Grown (never cropped) to the panel's aspect ratio, so the zoom fills
      // the panel without squashing the face.
      const panelAspect = size.w / size.h
      if (sw / sh < panelAspect) {
        const grown = sh * panelAspect
        sx -= (grown - sw) / 2
        sw = grown
      } else {
        const grown = sw / panelAspect
        sy -= (grown - sh) / 2
        sh = grown
      }
      const zoom = size.w / sw
      mirrored(eyeCtx, size, () => {
        // Source rectangles reaching outside the frame are clipped by
        // drawImage, and it scales the destination to match, so the mapping
        // below stays correct without clamping anything here.
        eyeCtx.drawImage(video, sx, sy, sw, sh, 0, 0, size.w, size.h)
        if (showAnnotationsRef.current) drawEyeOverlay(marks, result, { sx, sy, zoom, vw, vh }, size)
      })
      label(eyeCtx, `eyes · ${zoom.toFixed(1)}x${showAnnotationsRef.current ? '' : ' (overlay off — A)'}`)
    }

    // Drawn in crop space, inside drawEyes' mirror transform.
    const drawEyeOverlay = (
      marks: NonNullable<GazeResult['facialLandmarks']>,
      result: GazeResult | null,
      crop: { sx: number; sy: number; zoom: number; vw: number; vh: number },
      size: Size,
    ) => {
      const { sx, sy, zoom, vw, vh } = crop
      const at = (i: number): [number, number] => [(marks[i].x * vw - sx) * zoom, (marks[i].y * vh - sy) * zoom]

      // Only the landmarks actually inside the crop, so the whole face's
      // worth of dots does not pile up along the edges.
      eyeCtx.fillStyle = COLOR.mesh
      for (const m of marks) {
        const px = (m.x * vw - sx) * zoom
        const py = (m.y * vh - sy) * zoom
        if (px < 0 || py < 0 || px > size.w || py > size.h) continue
        eyeCtx.fillRect(px - 1, py - 1, 2, 2)
      }

      const eyes = eyeMarks(at)
      eyes.forEach((eye, i) => {
        eyeCtx.strokeStyle = EYE_COLORS[i]
        eyeCtx.lineWidth = 2
        eyeCtx.beginPath()
        eyeCtx.arc(eye.x, eye.y, eye.r, 0, Math.PI * 2)
        eyeCtx.stroke()
      })

      // Iris centres, when the model provides them. Ordered by image side to
      // match the rings above rather than trusting the index order.
      if (marks.length >= REFINED_LANDMARK_COUNT) {
        const irises = [at(IRIS_A), at(IRIS_B)].sort((a, b) => a[0] - b[0])
        irises.forEach(([px, py], i) => {
          eyeCtx.fillStyle = EYE_COLORS[i]
          eyeCtx.beginPath()
          eyeCtx.arc(px, py, 3, 0, Math.PI * 2)
          eyeCtx.fill()
        })
      }

      // One eye separation is the natural "face unit" at this zoom - the
      // face's cheeks are usually outside the crop entirely.
      drawGazeBars(eyeCtx, eyes, result, Math.hypot(eyes[1].x - eyes[0].x, eyes[1].y - eyes[0].y))
    }

    const drawPlane = (result: GazeResult | null) => {
      const size = sizes.get(plane)
      if (!size) return
      planeCtx.fillStyle = '#000'
      planeCtx.fillRect(0, 0, size.w, size.h)
      label(planeCtx, 'screen plane')

      // The viewport rectangle is inset, so samples that land off-screen
      // (the interesting failure) are still visible instead of clipped away.
      const rx = size.w * 0.12
      const ry = size.h * 0.16
      const rw = size.w - rx * 2
      const rh = size.h - ry * 2
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

      // Head position from faceOrigin3D (centimetres from the camera), and
      // the two eyes either side of it. See HEAD_RANGE_CM.
      let eyePoints: [number, number][] = []
      const origin = result?.faceOrigin3D
      if (origin && origin.length >= 2 && Number.isFinite(origin[0])) {
        // This panel is the screen as YOU face it, so x runs the opposite way
        // to the camera's: the camera looks back at you, so its +x (toward
        // the right of the raw frame) is your left. Negating here is the same
        // flip the camera panels get from their mirror transform, which is
        // what makes "head drifted left" mean the same thing in both - and
        // puts the cyan eye on the left in both.
        const ex = (cm: number) => Math.max(-0.9, Math.min(0.9, -cm / HEAD_RANGE_CM))
        const hy = Math.max(-0.9, Math.min(0.9, origin[1] / HEAD_RANGE_CM))
        const head = toPx(ex(origin[0]), hy)
        eyePoints = [toPx(ex(origin[0] + IPD_CM / 2), hy), toPx(ex(origin[0] - IPD_CM / 2), hy)]
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
        // The same two bars as the annotated view, seen from the other side:
        // there they leave the eyes, here they arrive at the point on the
        // screen they were aimed at.
        const eyeColors = [COLOR.eyeA, COLOR.eyeB]
        eyePoints.forEach((eye, i) => {
          planeCtx.strokeStyle = eyeColors[i]
          planeCtx.lineWidth = 2
          planeCtx.lineCap = 'round'
          planeCtx.beginPath()
          planeCtx.moveTo(eye[0], eye[1])
          planeCtx.lineTo(gx, gy)
          planeCtx.stroke()
          planeCtx.lineCap = 'butt'
        })
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

      drawRaw()
      drawAnnotated(result)
      drawEyes(result)
      drawPlane(result)

      const status = statusRef.current
      if (status) {
        const pog = result?.normPog
        status.textContent = [
          `state ${result ? result.gazeState : '—'}`,
          `rate ${fps.toFixed(1)}/s`,
          `pog ${pog ? `${pog[0].toFixed(3)}, ${pog[1].toFixed(3)}` : '—'}`,
          `calib ${tracker.getCalibrationPairs().length} pts${tracker.isCorrectionFromFile() ? ' (file)' : ''}`,
          `overlay ${showAnnotationsRef.current ? 'on' : 'off'}`,
        ].join('   ')
      }
    }

    // Drawn once synchronously before the loop starts. requestAnimationFrame
    // does not fire while the tab is hidden or otherwise not compositing, so
    // without this the panels can sit completely blank - indistinguishable
    // from "the tracker died", which is the exact confusion they exist to
    // prevent.
    renderFrame()
    const animate = () => {
      frameId = window.requestAnimationFrame(animate)
      renderFrame()
    }
    frameId = window.requestAnimationFrame(animate)
    return () => {
      window.cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [resultRef, tracker, showAnnotationsRef])

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      {/* Raw and annotated share the top row so the two can be compared
          without looking away - the whole reason for keeping an unannotated
          copy is that it sits beside the annotated one, not under it. */}
      <div className="flex min-h-0 flex-1">
        <canvas ref={rawRef} className="h-full min-w-0 flex-1" />
        <canvas ref={annotatedRef} className="h-full min-w-0 flex-1 border-l border-white/10" />
      </div>
      <canvas ref={eyeZoomRef} className="min-h-0 w-full flex-1 border-t border-white/10" />
      <canvas ref={planeRef} className="min-h-0 w-full flex-1 border-t border-white/10" />
      <div
        ref={statusRef}
        className="shrink-0 border-t border-white/10 px-3 py-2 font-mono text-[11px] text-white/60"
      />
    </div>
  )
}

export default FaceTrackDebugView
