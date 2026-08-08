// Save/restore the eye -> screen gaze mapping, so the 9-dot phase can be done
// once and replayed on every subsequent reload. Development tooling: sitting
// through nine 1.3s dots before every test of the trials, the gaze blob, or
// the profile submit is the slowest part of the loop by a wide margin.
//
// WHAT IS STORED, AND WHY IT IS NOT THE LIBRARY'S OWN CALIBRATION
//
// WebEyeTrack's calibration lives in two places: an affine matrix (a tf
// Tensor2D on a private field) and a gradient fine-tune of the BlazeGaze
// weights. Neither is reachable through the public API - there is no export,
// no setter, and constructing a replacement tf.Tensor would need a second
// @tensorflow/tfjs instance whose kernel registry is not the one the bundled
// copy uses. Replaying the raw inputs to adapt() is not an option either:
// obtainEyePatch emits a 512x128 RGBA patch (256KB each), so the ~72 patches
// behind one 9-dot run are ~18MB before encoding.
//
// So this fits its own correction instead, over a quantity that IS public:
// the normPog the tracker reports. During the dot phase each dot yields one
// (observed normPog -> true dot position) pair, and a 2D affine is least-
// squares fitted across them. Applying that to later normPog values
// reproduces the same kind of correction the library's own affine does.
//
// Deliberately fitted on the tracker's OUTPUT rather than its internal
// pre-Kalman prediction: that is the exact quantity the correction is later
// applied to, so the fit and its use agree. The observed values recorded here
// are always the RAW (uncorrected) ones, so a saved file is never expressed in
// terms of a correction that was itself already loaded from a file.

// [a, b, c, d, e, f] for:  x' = ax + by + c ,  y' = dx + ey + f
export type AffineMatrix = [number, number, number, number, number, number]

export interface GazeCalibrationPoint {
  // Viewport-normalized [-0.5, 0.5], the tracker's normPog convention.
  observed: [number, number]
  target: [number, number]
}

export const GAZE_FILE_KIND = 'distill-gaze-calibration'
export const GAZE_FILE_VERSION = 1

export interface GazeCalibrationFile {
  kind: typeof GAZE_FILE_KIND
  version: number
  savedAt: number
  // Metadata only. normPog is viewport-normalized so the fit is resolution
  // independent, but the mapping still encodes where the camera sits relative
  // to the screen - a file captured on a very differently shaped window is
  // worth a warning rather than silent trust.
  viewport: { width: number; height: number }
  points: GazeCalibrationPoint[]
  matrix: AffineMatrix
}

export type GazeParseResult =
  | { ok: true; file: GazeCalibrationFile; warning?: string }
  | { ok: false; error: string }

// Solves a 3x3 system by Gaussian elimination with partial pivoting. Returns
// null when the matrix is singular - which happens for real, not just in
// theory: dots captured while the face was lost collapse to identical
// observations, leaving the normal equations rank deficient.
function solve3x3(a: number[][], b: number[]): [number, number, number] | null {
  const m = [
    [a[0][0], a[0][1], a[0][2], b[0]],
    [a[1][0], a[1][1], a[1][2], b[1]],
    [a[2][0], a[2][1], a[2][2], b[2]],
  ]
  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null
    ;[m[col], m[pivot]] = [m[pivot], m[col]]
    for (let row = 0; row < 3; row++) {
      if (row === col) continue
      const factor = m[row][col] / m[col][col]
      for (let k = col; k < 4; k++) m[row][k] -= factor * m[col][k]
    }
  }
  const solution: [number, number, number] = [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]]
  return solution.every((v) => Number.isFinite(v)) ? solution : null
}

// Least-squares affine over the pairs. x' and y' share the same design matrix
// ([x, y, 1] per row) and differ only in their right-hand side, so the 3x3
// normal matrix is built once and reused for both.
export function fitAffine(points: GazeCalibrationPoint[]): AffineMatrix | null {
  if (points.length < 3) return null

  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const atbx = [0, 0, 0]
  const atby = [0, 0, 0]

  for (const { observed, target } of points) {
    const row = [observed[0], observed[1], 1]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) ata[i][j] += row[i] * row[j]
      atbx[i] += row[i] * target[0]
      atby[i] += row[i] * target[1]
    }
  }

  const solvedX = solve3x3(ata, atbx)
  const solvedY = solve3x3(ata, atby)
  if (!solvedX || !solvedY) return null
  return [solvedX[0], solvedX[1], solvedX[2], solvedY[0], solvedY[1], solvedY[2]]
}

export function applyAffine(m: AffineMatrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]
}

// Mean distance between each corrected observation and its target, in
// normalized units. Surfaced after a fit so a bad capture (face lost for most
// of the dots) is visible as a number rather than only as a blob that sits in
// the wrong place later.
export function residualError(m: AffineMatrix, points: GazeCalibrationPoint[]): number {
  if (points.length === 0) return 0
  const total = points.reduce((sum, { observed, target }) => {
    const [x, y] = applyAffine(m, observed[0], observed[1])
    return sum + Math.hypot(x - target[0], y - target[1])
  }, 0)
  return total / points.length
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function toPair(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  if (!isFiniteNumber(v[0]) || !isFiniteNumber(v[1])) return null
  return [v[0], v[1]]
}

export function buildGazeCalibrationFile(
  points: GazeCalibrationPoint[],
  matrix: AffineMatrix,
): GazeCalibrationFile {
  return {
    kind: GAZE_FILE_KIND,
    version: GAZE_FILE_VERSION,
    savedAt: Date.now(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    points,
    matrix,
  }
}

// Same untrusted-input posture as calibrationFile.ts: a file off disk can be
// truncated, hand-edited or simply the wrong file, and this one feeds a
// matrix straight into a per-frame transform.
export function parseGazeCalibrationFile(raw: string): GazeParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: "that file isn't valid JSON" }
  }
  if (!isRecord(parsed)) return { ok: false, error: 'that file does not contain a calibration object' }
  if (parsed.kind !== GAZE_FILE_KIND) {
    return {
      ok: false,
      error:
        parsed.kind === 'distill-calibration'
          ? 'that is a profile file, not an eye-tracking calibration file'
          : "that doesn't look like a Distill eye calibration file",
    }
  }
  if (!isFiniteNumber(parsed.version) || parsed.version > GAZE_FILE_VERSION) {
    return { ok: false, error: `that file was saved by a newer build (v${String(parsed.version)})` }
  }

  const matrixRaw = parsed.matrix
  if (!Array.isArray(matrixRaw) || matrixRaw.length !== 6 || !matrixRaw.every(isFiniteNumber)) {
    return { ok: false, error: 'its "matrix" field is missing or malformed' }
  }
  const matrix = matrixRaw as AffineMatrix

  const points: GazeCalibrationPoint[] = []
  if (Array.isArray(parsed.points)) {
    for (const entry of parsed.points) {
      if (!isRecord(entry)) continue
      const observed = toPair(entry.observed)
      const target = toPair(entry.target)
      if (observed && target) points.push({ observed, target })
    }
  }

  const viewport = isRecord(parsed.viewport) ? parsed.viewport : null
  const width = viewport && isFiniteNumber(viewport.width) ? viewport.width : window.innerWidth
  const height = viewport && isFiniteNumber(viewport.height) ? viewport.height : window.innerHeight

  // Not fatal - the fit is in normalized units, so a different window size
  // still broadly applies. But the camera-to-screen geometry it encodes does
  // not survive a big change, so say so rather than pretending otherwise.
  const ratio = Math.max(width / window.innerWidth, window.innerWidth / width)
  const warning =
    ratio > 1.25
      ? `Saved at ${Math.round(width)}x${Math.round(height)}, this window is ${window.innerWidth}x${window.innerHeight} — accuracy may be off.`
      : undefined

  return {
    ok: true,
    warning,
    file: {
      kind: GAZE_FILE_KIND,
      version: parsed.version,
      savedAt: isFiniteNumber(parsed.savedAt) ? parsed.savedAt : Date.now(),
      viewport: { width, height },
      points,
      matrix,
    },
  }
}

export function downloadGazeCalibrationFile(file: GazeCalibrationFile): void {
  const date = new Date(file.savedAt)
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `distill-eye-calibration-${stamp}.json`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
