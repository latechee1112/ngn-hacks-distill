import { useEffect, useRef, useState } from 'react'
import Icon from '../../sidepanel/Icon'
import {
  CALIBRATION_DOT_INTERVAL_MS,
  CALIBRATION_DOTS,
  CALIBRATION_SETTLE_MS,
  dotToNormalizedPoint,
} from './calibrationFit'
import { GAZE_VIDEO_ID, type GazeTracker } from './useGazeTracker'

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-surface-variant focus-visible:ring-offset-2 focus-visible:ring-offset-background'

// The dots used to begin the instant this component mounted, straight off the
// back of the camera-permission prompt - nine targets appearing and vanishing
// on a 1.3s timer with a single line of explanation and no way to prepare.
// Now: read what is about to happen, start it yourself, then a short count so
// the first dot is expected rather than sprung.
type Phase = 'intro' | 'countdown' | 'dots'

const COUNTDOWN_FROM = 3
const COUNTDOWN_TICK_MS = 800

// Radius of the dwell ring in the dot's own 40x40 viewBox. The keyframe in
// index.css animates stroke-dashoffset from 107 -> 0, which is this circle's
// circumference (2 * pi * 17 = 106.8) rounded.
const RING_RADIUS = 17
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function DotCalibration({
  tracker,
  onDone,
  onError,
}: {
  tracker: GazeTracker
  onDone: () => void
  onError: (message: string) => void
}) {
  const [phase, setPhase] = useState<Phase>('intro')
  const [count, setCount] = useState(COUNTDOWN_FROM)
  const [dotIndex, setDotIndex] = useState(0)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    // Started during the intro, not when the dots do: the camera permission
    // prompt, MediaPipe's WASM load and the first inference all resolve while
    // the user is still reading, so pressing "Start" lands on a tracker that
    // is already warm instead of one still initialising under the first dot.
    // App.tsx renders the actual <video id={GAZE_VIDEO_ID}> element - it
    // mounts in the same commit as this component (both appear together
    // once step becomes 'gazeCalibration'), so it's already in the DOM by
    // the time this effect runs.
    tracker.start(GAZE_VIDEO_ID).catch((err) => onError(err instanceof Error ? err.message : String(err)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== 'countdown') return
    const tick = window.setTimeout(() => {
      // The final tick hands straight off to the dots rather than counting
      // down to a displayed "0" - which also keeps the phase change inside
      // the timeout instead of making it a synchronous setState in this
      // effect's body (a cascading render, and a lint error).
      if (count <= 1) setPhase('dots')
      else setCount((c) => c - 1)
    }, COUNTDOWN_TICK_MS)
    return () => window.clearTimeout(tick)
  }, [phase, count])

  useEffect(() => {
    if (phase !== 'dots' || !tracker.ready) return
    if (dotIndex >= CALIBRATION_DOTS.length) {
      onDone()
      return
    }
    // Two-phase dwell: settle discards whatever the buffer picked up while
    // the eye was still moving toward this dot (reaction time + saccade),
    // then capture registers only what accumulates after that - see
    // CALIBRATION_SETTLE_MS in calibrationFit.ts for why this matters more
    // than it looks like it should.
    const settle = window.setTimeout(() => {
      tracker.clearCalibrationBuffer()
    }, CALIBRATION_SETTLE_MS)
    const capture = window.setTimeout(() => {
      const [x, y] = dotToNormalizedPoint(CALIBRATION_DOTS[dotIndex])
      tracker.registerCalibrationPoint(x, y)
      setDotIndex((i) => i + 1)
    }, CALIBRATION_DOT_INTERVAL_MS)
    return () => {
      window.clearTimeout(settle)
      window.clearTimeout(capture)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, tracker.ready, dotIndex])

  if (phase === 'intro') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 bg-background px-6 text-center">
        <div className="flex items-center gap-2 text-on-surface-variant">
          <Icon name="eye" />
          <span className="text-meta font-semibold tracking-[0.08em] uppercase">Eye tracking</span>
        </div>
        <h1 className="text-title font-semibold text-on-background">Next, a quick look around the screen</h1>
        <div className="flex max-w-md flex-col gap-3 text-left">
          {[
            `${CALIBRATION_DOTS.length} dots will appear, one at a time.`,
            'Look at each one until it moves. A ring around the dot shows when it is about to.',
            'It takes about 15 seconds in total.',
            'Try to keep your head still. Blinking is completely fine.',
          ].map((line) => (
            <div key={line} className="flex items-start gap-3">
              <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-text" />
              <p className="text-body text-on-surface-variant">{line}</p>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setPhase('countdown')}
          className={`rounded-md bg-accent px-6 py-3 text-body font-medium text-accent-fg transition-colors hover:bg-accent-hover ${FOCUS_RING}`}
        >
          I'm ready
        </button>
        <p className="text-meta text-on-surface-muted">Nothing is recorded — the camera feed never leaves this page.</p>
      </div>
    )
  }

  if (phase === 'countdown') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-background text-center">
        <p className="text-body text-on-surface-variant">Get ready — look at the first dot</p>
        <p aria-live="assertive" className="text-[64px] leading-none font-semibold text-on-background tabular-nums">
          {count}
        </p>
      </div>
    )
  }

  const dot = CALIBRATION_DOTS[Math.min(dotIndex, CALIBRATION_DOTS.length - 1)]

  return (
    <div className="fixed inset-0 bg-background">
      <p className="absolute inset-x-0 top-10 text-center text-body text-on-surface-variant">
        Look at each dot until it moves · {Math.min(dotIndex + 1, CALIBRATION_DOTS.length)} of{' '}
        {CALIBRATION_DOTS.length}
      </p>
      {dotIndex < CALIBRATION_DOTS.length && (
        // No position transition. The old `transition-all duration-300` slid
        // the dot between locations, which was wrong twice over: gliding
        // motion is exactly what a motion-sensitive user does not want, and
        // it made the eye smooth-pursue the slide instead of saccading to a
        // new position - so CALIBRATION_SETTLE_MS, which budgets for reaction
        // time plus a saccade, was covering the wrong 300ms entirely. It
        // jumps now, which is both calmer to watch and what the settle window
        // actually assumes.
        <div
          className="absolute h-10 w-10 -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${dot.xFraction * 100}%`, top: `${dot.yFraction * 100}%` }}
        >
          <svg viewBox="0 0 40 40" className="absolute inset-0 -rotate-90" aria-hidden="true">
            <circle
              cx="20"
              cy="20"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="3"
              className="stroke-outline-strong"
            />
            {/* Remounted per dot (key) so the fill animation restarts from
                empty each time rather than carrying the previous dot's
                progress over. */}
            <circle
              key={dotIndex}
              cx="20"
              cy="20"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              className="dot-dwell stroke-accent-text"
              style={{ ['--dwell-ms' as string]: `${CALIBRATION_DOT_INTERVAL_MS}ms` }}
            />
          </svg>
          {/* Raised from 16px: a 16px dot is a hard fixation target for the
              low-vision half of this extension's audience, and a vague
              fixation point is also worse calibration data. */}
          <div className="absolute top-1/2 left-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-text" />
        </div>
      )}
    </div>
  )
}

export default DotCalibration
