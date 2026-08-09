import { useEffect, useRef, useState } from 'react'
import Icon from '../../sidepanel/Icon'
import {
  CALIBRATION_DOT_INTERVAL_MS,
  CALIBRATION_DOTS,
  CALIBRATION_MOVE_MS,
  CALIBRATION_SETTLE_MS,
  dotToNormalizedPoint,
} from './calibrationFit'
import { parseGazeCalibrationFile } from './gazeCalibrationFile'
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

// Derived rather than written into the copy as a literal, so slowing the dots
// down (as CALIBRATION_DOT_INTERVAL_MS just was) can't leave the intro
// promising a duration the sequence no longer takes. Every dot costs its dwell
// plus its travel; the first dot's travel is zero, which is inside the rounding.
const ESTIMATED_SECONDS = Math.round(
  (CALIBRATION_DOTS.length * (CALIBRATION_DOT_INTERVAL_MS + CALIBRATION_MOVE_MS)) / 1000,
)

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
  const [loadError, setLoadError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Read once via a lazy initializer - this component's lifetime is a handful
  // of seconds, so a live subscription to changes buys nothing, and state
  // (read freely during render) is the right tool here rather than a ref
  // (which react-hooks/refs flags reading during render, since a ref update
  // wouldn't repaint - this one is never written after mount, so that's moot,
  // but state sidesteps the lint rule entirely). Mirrors App.tsx's own inline
  // check.
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  // The very first dot has nothing to travel from, so it just appears -
  // arrival is immediate either way. Every dot after that travels for
  // CALIBRATION_MOVE_MS, unless reduced motion asks for the old instant jump.
  const arrivalDelayMs = dotIndex === 0 || reducedMotion ? 0 : CALIBRATION_MOVE_MS

  // Development shortcut: install a previously fitted eye -> screen mapping
  // and skip straight past the dots. onDone() is the same callback the real
  // sequence ends with, so everything downstream (practice, trials, the gaze
  // blob) runs exactly as it would have.
  async function handleGazeFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const picked = input.files?.[0]
    input.value = ''
    if (!picked) return
    setLoadError('')
    const parsed = parseGazeCalibrationFile(await picked.text())
    if (!parsed.ok) {
      setLoadError(`Couldn't load that file - ${parsed.error}.`)
      return
    }
    if (parsed.warning) console.warn('[Distill]', parsed.warning)
    // Points come along with the matrix so later trial clicks refine this
    // mapping rather than refitting a competing one from their own handful of
    // pairs.
    tracker.setGazeCorrection(parsed.file.matrix, parsed.file.points)
    onDone()
  }

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
    // than it looks like it should. Both delays are pushed back by
    // arrivalDelayMs so that budget starts counting from when the dot
    // actually lands (its CALIBRATION_MOVE_MS transition, tracked in the JSX
    // below) rather than from the moment dotIndex changes and the dot is
    // still travelling.
    const settle = window.setTimeout(() => {
      tracker.clearCalibrationBuffer()
    }, arrivalDelayMs + CALIBRATION_SETTLE_MS)
    const capture = window.setTimeout(() => {
      const [x, y] = dotToNormalizedPoint(CALIBRATION_DOTS[dotIndex])
      tracker.registerCalibrationPoint(x, y)
      setDotIndex((i) => i + 1)
    }, arrivalDelayMs + CALIBRATION_DOT_INTERVAL_MS)
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
            `It takes about ${ESTIMATED_SECONDS} seconds in total.`,
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
        <p className="text-meta text-on-surface-muted">Nothing is recorded - the camera feed never leaves this page.</p>

        {/* Development affordance, kept visually quiet so it reads as a tool
            rather than a step. */}
        <div className="mt-2 flex flex-col items-center gap-2 border-t border-outline pt-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleGazeFileChosen}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-meta text-on-surface-muted transition-colors hover:text-on-surface-variant ${FOCUS_RING}`}
          >
            <Icon name="upload" />
            Load a saved eye calibration
          </button>
          {loadError && (
            <p role="alert" className="max-w-sm text-meta text-danger-text">
              {loadError}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (phase === 'countdown') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-background text-center">
        <p className="text-body text-on-surface-variant">Get ready - look at the first dot</p>
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
        // Travels to its new spot over CALIBRATION_MOVE_MS rather than
        // teleporting (transitionDuration below), landing with a shockwave
        // burst (the sibling .dot-shockwave ring). An earlier version of this
        // slid the dot too and reverted it: gliding motion is unwanted for
        // this extension's motion-sensitive users, and the eye smooth-pursuing
        // the slide meant CALIBRATION_SETTLE_MS's reaction-time-plus-saccade
        // budget was covering the wrong window. Both are handled now rather
        // than avoided - reducedMotion zeroes the transition (and the CSS
        // media query below independently kills the shockwave) for anyone who
        // asked for less motion, and arrivalDelayMs pushes the settle/capture
        // timers (see the effect above) back to start counting from when the
        // dot actually lands instead of from dotIndex changing.
        <div
          className="absolute h-10 w-10 -translate-x-1/2 -translate-y-1/2 transition-[left,top] ease-[cubic-bezier(0.16,1,0.3,1)]"
          style={{
            left: `${dot.xFraction * 100}%`,
            top: `${dot.yFraction * 100}%`,
            transitionDuration: reducedMotion ? '0ms' : `${CALIBRATION_MOVE_MS}ms`,
          }}
        >
          {/* Transparent but for the box-shadow ring - the solid fixation dot
              below renders on top of it, so this only ever contributes the
              expanding/fading ring, never a second solid circle. Keyed per
              dot so it remounts and restarts on every arrival. */}
          <div
            key={dotIndex}
            aria-hidden="true"
            className="dot-shockwave absolute top-1/2 left-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ animationDelay: `${arrivalDelayMs}ms` }}
          />
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
                progress over. Delayed by arrivalDelayMs so it only starts
                filling once the dot has actually landed - kept in step with
                the settle/capture timers above, which the same delay offsets. */}
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
              style={{
                ['--dwell-ms' as string]: `${CALIBRATION_DOT_INTERVAL_MS}ms`,
                animationDelay: `${arrivalDelayMs}ms`,
              }}
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
