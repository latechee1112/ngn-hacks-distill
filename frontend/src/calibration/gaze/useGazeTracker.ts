import { useCallback, useRef, useState } from 'react'
import { WebEyeTrack, WebcamClient, type GazeResult } from 'webeyetrack'
import { applyAffine, fitAffine, type AffineMatrix, type GazeCalibrationPoint } from './gazeCalibrationFile'

// Deliberately NOT WebEyeTrackProxy - two reasons, both verified against the
// installed package source (webeyetrack@0.0.2), not just its docs:
//   1. The proxy's worker is broken as shipped: the package ships
//      dist/index.worker.js.LICENSE.txt but not the actual worker file, and
//      there is no `new Worker(...)` anywhere in dist/index.js at all.
//   2. WebEyeTrack itself has zero worker dependency - step()/handleClick()
//      run in plain async methods - so a worker was never actually needed
//      for our case (a dedicated calibration tab, not a widget embedded in
//      an arbitrary host page under memory/CPU pressure).
// The proxy also attaches a global `window.addEventListener('click')` that
// feeds every click on the page into calibration, indiscriminately. Driving
// WebEyeTrack directly means we decide exactly when calibration data gets
// registered: the 9 calibration dots, plus (App.tsx's handleTargetHit) a
// correct trial click - never decoy clicks or wrong-shape clicks, which
// don't reliably mean the gaze was actually there.
const MAX_CALIBRATION_POINTS = 9

// WHY THIS FILE NO LONGER CALLS WebEyeTrack.adapt()
//
// adapt() was the single worst thing happening on this page. Measured against
// the bundle source, one call:
//   - concatenates EVERY stored calibration entry's eye patches, not just the
//     batch being registered. After the 9-dot phase that is 9 entries x 8
//     frames of [128, 512, 3] floats - a ~57MB tensor, rebuilt from scratch
//     each time;
//   - runs blazeGaze.predict over all of it to refit the affine;
//   - then runs tf.variableGrads (a full forward AND backward pass) over the
//     same batch;
//   - all synchronously, on the UI thread, with no worker (see above).
// App.tsx fires this on every correct trial click, so the stall landed exactly
// when the next trial's completion time starts being measured - the lag was
// corrupting the very number the trial exists to record. Capping the batch
// (maxSamples) never helped, because the cost is dominated by the previously
// stored dots, not by the new frames.
//
// What adapt() actually buys is an affine fit (computeAffineMatrixML - plain
// least squares) plus one Adam step at lr 1e-5. That gradient step moves the
// weights by ~1e-4 across a whole session: negligible. The affine is the real
// calibration, and least-squares affine is something we can do ourselves over
// nine (observed -> intended) pairs in microseconds - which is exactly what
// gazeCalibrationFile.ts already implements for the save/load feature.
//
// So the tracker now fits and applies its own correction and never calls
// adapt(). Three things fall out of that beyond the speed:
//   - normPog is always the raw BlazeGaze prediction, because the library's
//     own affineMatrix is never set. That makes the correction space constant.
//     Previously it was not: the library refits its affine after every dot, so
//     each dot was observed through a *different* correction, and a mapping
//     fitted across them was fitted across mixed spaces. Saved calibration
//     files inherited that inconsistency - a file captured after the dots was
//     in library-corrected space but replayed, on load, against uncorrected
//     predictions.
//   - no eye patches need retaining between frames. Holding 8 x 512x128 RGBA
//     ImageData (~2MB) and churning one per inference at 10Hz is gone.
//   - drift correction actually works as originally intended, since a refit on
//     each trial click now costs nothing.

// Shared with App.tsx, which owns the actual <video> element - it must stay
// mounted for the tracker's whole lifetime (calibration AND trials), not
// just while DotCalibration is on screen. WebcamClient's frame loop checks
// `this.videoElement.paused` every tick and silently no-ops otherwise; a
// <video> torn down by React on a step change stalls playback, which reads
// as "gaze samples just stop arriving" with no error anywhere.
export const GAZE_VIDEO_ID = 'distill-gaze-video'

// WebcamClient drives the callback from requestAnimationFrame. The package's
// advertised worker is missing from its published bundle, so MediaPipe + TFJS
// inference runs on the UI thread. Ten samples per second is responsive
// enough for gaze calibration while leaving regular frames for React, CSS and
// input. The in-flight guard in start() is equally important: without it a
// slow inference can overlap the next one and saturate the page completely.
const MIN_FRAME_INTERVAL_MS = 1000 / 10

// How many recent open-eye predictions one registered point is summarised
// from. At MIN_FRAME_INTERVAL_MS (~10Hz) this is roughly the last 800ms -
// sized to use nearly the whole CALIBRATION_DOT_INTERVAL_MS dwell rather than
// only its tail. Summarising a window (rather than taking the single frame at
// the moment of registration, which is all the library's own handleClick ever
// uses) is what stops one blink or landmark glitch at exactly the wrong
// millisecond from skewing a point permanently.
const CALIBRATION_SAMPLE_BUFFER_SIZE = 8

export interface GazeTracker {
  ready: boolean
  start: (videoElementId: string) => Promise<void>
  stop: () => void
  // x/y are viewport-normalized, range [-0.5, 0.5], same convention as
  // GazeResult.normPog. Records one (observed -> intended) pair and refits
  // the correction. maxSamples caps how many of the most recent buffered
  // predictions are summarised - a dot uses its whole dwell, a trial click
  // only the frames either side of the click itself.
  registerCalibrationPoint: (x: number, y: number, maxSamples?: number) => void
  // Drops whatever's accumulated in the prediction buffer - see
  // CALIBRATION_SETTLE_MS in calibrationFit.ts. Lets a caller discard
  // pre-settle frames after a new dot appears, so only frames captured once
  // the eye has actually arrived contribute to the next registered point.
  clearCalibrationBuffer: () => void

  // --- Saved eye -> screen mapping. See gazeCalibrationFile.ts.
  getCalibrationPairs: () => GazeCalibrationPoint[]
  getGazeCorrection: () => AffineMatrix | null
  // Installs a mapping fitted elsewhere (i.e. loaded from a file) and seeds
  // the pair list with the points behind it, so later trial clicks refine
  // that mapping rather than starting a competing one from scratch.
  setGazeCorrection: (matrix: AffineMatrix, points: GazeCalibrationPoint[]) => void
  isCorrectionFromFile: () => boolean
}

export function useGazeTracker(onSample: (result: GazeResult, capturedAt: number) => void): GazeTracker {
  const trackerRef = useRef<WebEyeTrack | null>(null)
  const webcamRef = useRef<WebcamClient | null>(null)
  const activeRef = useRef(false)
  const [ready, setReady] = useState(false)
  // Rolling window of recent raw predictions, for registerCalibrationPoint to
  // summarise - see CALIBRATION_SAMPLE_BUFFER_SIZE above.
  const recentRawPogsRef = useRef<[number, number][]>([])
  const calibPairsRef = useRef<GazeCalibrationPoint[]>([])
  const correctionRef = useRef<AffineMatrix | null>(null)
  const fromFileRef = useRef(false)

  const start = useCallback(
    async (videoElementId: string) => {
      // Idempotent. The debug page starts the camera itself and can then
      // mount DotCalibration over the top of it, which starts the tracker on
      // mount unconditionally - a second WebEyeTrack and a second
      // WebcamClient on the same <video> would leave two inference loops
      // fighting over one element.
      if (activeRef.current) {
        setReady(true)
        return
      }
      const tracker = new WebEyeTrack(MAX_CALIBRATION_POINTS)
      await tracker.initialize()
      trackerRef.current = tracker
      activeRef.current = true

      const webcam = new WebcamClient(videoElementId)
      webcamRef.current = webcam
      let lastProcessedAt = 0
      let inferenceInFlight = false
      await webcam.startWebcam(async (frame, timestamp) => {
        if (!activeRef.current || !trackerRef.current || inferenceInFlight) return
        const now = performance.now()
        if (now - lastProcessedAt < MIN_FRAME_INTERVAL_MS) return
        lastProcessedAt = now
        inferenceInFlight = true
        try {
          const result = await trackerRef.current.step(frame, timestamp)
          // stop() may have been called while inference was yielding to the
          // GPU/WASM backend. Do not publish a late sample into the next step.
          if (!activeRef.current || !trackerRef.current) return
          if (result.gazeState === 'open') {
            recentRawPogsRef.current.push([result.normPog[0], result.normPog[1]])
            if (recentRawPogsRef.current.length > CALIBRATION_SAMPLE_BUFFER_SIZE) {
              recentRawPogsRef.current.shift()
            }
          }
          // The correction is applied on a copy: the library keeps its own
          // reference to `result` as latestGazeResult, and recentRawPogsRef
          // above must keep holding the uncorrected prediction, so correcting
          // in place would corrupt both.
          const correction = correctionRef.current
          const delivered =
            correction && result.gazeState === 'open'
              ? { ...result, normPog: applyAffine(correction, result.normPog[0], result.normPog[1]) }
              : result
          // performance.now() at callback time, not GazeResult.timestamp
          // (which is relative to video start, a different clock than the
          // trial start/end markers this later gets compared against).
          onSample(delivered, performance.now())
        } finally {
          inferenceInFlight = false
        }
      })
      setReady(true)
    },
    [onSample],
  )

  const stop = useCallback(() => {
    activeRef.current = false
    webcamRef.current?.stopWebcam()
    webcamRef.current = null
    trackerRef.current = null
    recentRawPogsRef.current = []
    // calibPairsRef and correctionRef deliberately survive stop(): the camera
    // is stopped as soon as the trials finish (App.tsx's submit), and the
    // results screen still has to be able to save the mapping that run
    // produced.
    setReady(false)
  }, [])

  const registerCalibrationPoint = useCallback((x: number, y: number, maxSamples?: number) => {
    // Buffer is cleared after every dot, so a dot with the eyes closed or the
    // face lost for its whole dwell simply contributes nothing rather than
    // summarising stale frames left over from the previous dot.
    if (recentRawPogsRef.current.length === 0) return
    // Always the *most recent* frames, not the oldest - those are the ones
    // closest to the moment being registered (a click, or the end of a dot's
    // dwell), same reasoning as the rolling buffer's own shift() above.
    const takeLast = maxSamples && maxSamples < recentRawPogsRef.current.length ? maxSamples : 0
    const pool = takeLast ? recentRawPogsRef.current.slice(-takeLast) : recentRawPogsRef.current

    // Per-axis median, not mean: one frame captured mid-blink or mid-saccade
    // drags a mean of 8 noticeably, and this is one of only ~9 points the fit
    // is built from.
    const axis = (i: 0 | 1) => {
      const sorted = pool.map((p) => p[i]).sort((a, b) => a - b)
      return sorted[Math.floor(sorted.length / 2)]
    }
    calibPairsRef.current.push({ observed: [axis(0), axis(1)], target: [x, y] })

    // Refit across every pair gathered so far - nine dots, plus a point per
    // correct trial click. This is the drift correction the trial-click path
    // was always meant to provide, now at a cost (a 3x3 least-squares solve)
    // that genuinely is free, instead of a ~57MB tensor round trip.
    const fitted = fitAffine(calibPairsRef.current)
    if (fitted) {
      correctionRef.current = fitted
      fromFileRef.current = false
    }
    recentRawPogsRef.current = []
  }, [])

  const clearCalibrationBuffer = useCallback(() => {
    recentRawPogsRef.current = []
  }, [])

  const getCalibrationPairs = useCallback(() => calibPairsRef.current, [])
  const getGazeCorrection = useCallback(() => correctionRef.current, [])
  const setGazeCorrection = useCallback((matrix: AffineMatrix, points: GazeCalibrationPoint[]) => {
    correctionRef.current = matrix
    calibPairsRef.current = [...points]
    fromFileRef.current = true
  }, [])
  const isCorrectionFromFile = useCallback(() => fromFileRef.current, [])

  return {
    ready,
    start,
    stop,
    registerCalibrationPoint,
    clearCalibrationBuffer,
    getCalibrationPairs,
    getGazeCorrection,
    setGazeCorrection,
    isCorrectionFromFile,
  }
}
