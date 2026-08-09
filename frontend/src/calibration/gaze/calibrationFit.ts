// 9-point calibration sequence. No manual model-fitting needed here -
// useGazeTracker.ts's registerCalibrationPoint does the whole affine fit +
// gradient fine-tune internally via WebEyeTrack.adapt(), fed a rolling
// buffer of recent open-eye frames rather than a single clicked-moment
// sample. This module is just the dot layout.

export interface CalibrationDot {
  id: string
  // Viewport fractions, 0-1. Corners + edge midpoints + center - the
  // library's own default maxPoints is 5; raised to 9 for headroom.
  xFraction: number
  yFraction: number
}

// Order deliberately alternates vertical (and mostly horizontal) direction
// every step - center, then zig-zagging corners/edges - instead of the
// obvious row-by-row top-to-bottom sweep. A monotonic sweep means every
// transition points the same way, so if any pre-settle frames leak into a
// dot's fit (see CALIBRATION_SETTLE_MS below) they all bias that dot's
// label in the same direction and compound across dots instead of
// cancelling out.
export const CALIBRATION_DOTS: CalibrationDot[] = [
  { id: 'center', xFraction: 0.5, yFraction: 0.5 },
  { id: 'top-left', xFraction: 0.08, yFraction: 0.1 },
  { id: 'bottom-right', xFraction: 0.92, yFraction: 0.9 },
  { id: 'top-right', xFraction: 0.92, yFraction: 0.1 },
  { id: 'bottom-left', xFraction: 0.08, yFraction: 0.9 },
  { id: 'top-center', xFraction: 0.5, yFraction: 0.1 },
  { id: 'bottom-center', xFraction: 0.5, yFraction: 0.9 },
  { id: 'mid-left', xFraction: 0.08, yFraction: 0.5 },
  { id: 'mid-right', xFraction: 0.92, yFraction: 0.5 },
]

// WebEyeTrack.handleClick(x, y) expects the same normalization its own
// normPog output uses: viewport-relative, origin at center, range [-0.5, 0.5].
export function dotToNormalizedPoint(dot: CalibrationDot): [number, number] {
  return [dot.xFraction - 0.5, dot.yFraction - 0.5]
}

// Time to dwell on each dot before registering it. 1.8x the original 1300ms:
// holding each position longer gives the eye room to actually settle and
// makes the sequence feel less rushed, at the cost of a longer run overall
// (see the intro copy's stated duration in DotCalibration.tsx, which is
// derived from this). CALIBRATION_SETTLE_MS below is deliberately NOT scaled
// with it - that budget covers reaction time and the saccade, which do not
// get slower just because the dot waits longer; leaving it fixed simply
// means more of the extra time lands in the capture window.
export const CALIBRATION_DOT_INTERVAL_MS = 2340

// Travel time for the dot's move-to-next-spot transition (DotCalibration.tsx)
// and the shockwave that fires on arrival. One constant shared by the CSS
// transition-duration and the JS arrival-offset math below so they can't
// drift apart, same as --dwell-ms is shared with CALIBRATION_DOT_INTERVAL_MS.
export const CALIBRATION_MOVE_MS = 240

// How long after a new dot appears to wait before the capture buffer starts
// filling - covers reaction time + the saccade to the dot + micro-settle,
// none of which reflect the eye actually being on-target yet. Without this,
// those early frames get labeled with the new dot's position while the eye
// is still near the *previous* dot, which - combined with a one-directional
// dot order - taught the model a systematic directional bias rather than
// random noise. DotCalibration.tsx clears the tracker's buffer at this mark
// rather than relying on CALIBRATION_SAMPLE_BUFFER_SIZE's rolling window to
// age the contaminated frames out; a bigger buffer (useGazeTracker.ts) only
// pulls in *more* of this pre-settle window, not less.
export const CALIBRATION_SETTLE_MS = 450
