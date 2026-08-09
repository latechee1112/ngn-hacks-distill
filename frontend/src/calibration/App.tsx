import { useCallback, useEffect, useRef, useState } from 'react'
import type { GazeResult } from 'webeyetrack'
import Icon from '../sidepanel/Icon'
import {
  CALIBRATION_STORAGE_KEY,
  USER_NAME_MAX_LENGTH,
  type CalibrationProfileResponse,
  type CalibrationTrial,
  type GazeSummary,
  type StoredCalibration,
} from '../types/calibration'
import { buildCalibrationFile, downloadCalibrationFile, parseCalibrationFile } from './calibrationFile'
import { combineGazeStats, computeTrialGazeStats, type TrialGazeStats } from './gaze/aggregate'
import {
  buildGazeCalibrationFile,
  downloadGazeCalibrationFile,
  fitAffine,
  residualError,
} from './gaze/gazeCalibrationFile'
import DotCalibration from './gaze/DotCalibration'
import { currentTargetRect, isOnTarget, toPagePoint, type PageGazePoint } from './gaze/hitTest'
import { GAZE_VIDEO_ID, useGazeTracker } from './gaze/useGazeTracker'
import NameScreen from './NameScreen'
import TrialTask from './TrialTask'
import { PRACTICE_TRIAL, TRIALS } from './trials'
import { PrimaryButton, QuietButton, Reveal, SecondaryButton, Shell } from './ui'
import WelcomeScreen from './WelcomeScreen'

// Same backend the background service worker's analyze-page calls use (see
// background.ts). Unlike a content script, this page runs at the extension's own
// chrome-extension:// origin, which is already on the backend's CORS allowlist (see
// backend/.env's CORS_ORIGINS), so it can call the backend directly instead of
// proxying through the background worker.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:8000'

async function markDismissed() {
  try {
    const record: StoredCalibration = { dismissed: true }
    await chrome.storage.local.set({ [CALIBRATION_STORAGE_KEY]: record })
  } catch {
    // Best-effort. Worst case, the popup's "Finish setup" banner reappears.
  }
}

async function storeResult(response: CalibrationProfileResponse, userName: string) {
  const record: StoredCalibration = {
    profile: response.profile,
    explanation: response.explanation,
    completedAt: Date.now(),
    dismissed: false,
  }
  // Omitted rather than stored as "" when blank, so consumers can test for the
  // field itself instead of having to treat empty string as absent.
  const trimmed = userName.trim().slice(0, USER_NAME_MAX_LENGTH)
  if (trimmed) record.userName = trimmed
  await chrome.storage.local.set({ [CALIBRATION_STORAGE_KEY]: record })
}

type Step =
  | 'welcome'
  | 'name'
  | 'camera'
  | 'gazeCalibration'
  | 'practice'
  | 'trials'
  | 'submitting'
  | 'results'
  | 'error'
  | 'skipped'

function App() {
  const [step, setStep] = useState<Step>('welcome')
  // Which way the wizard last moved, so the step transition can animate in
  // from the matching side (see .step-enter in index.css). Only 'name' can
  // currently go backwards; the rest of the flow is one-way by design.
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [trialIndex, setTrialIndex] = useState(0)
  const [trials, setTrials] = useState<CalibrationTrial[]>([])
  const [result, setResult] = useState<CalibrationProfileResponse | null>(null)
  const [error, setError] = useState('')
  // Kept separate from `error` above: that one owns the whole 'error' step
  // (a failed backend submit, with its own retry screen), while this renders
  // inline under the welcome screen's load button and must not navigate away
  // from it. Picking the wrong file should leave you exactly where you were,
  // free to pick another.
  const [importError, setImportError] = useState('')
  const [importedFromFile, setImportedFromFile] = useState(false)
  // Purely a display label for the popup's profile card. Nothing reads it to
  // make a decision, and leaving it blank changes nothing but the wording there.
  const [userName, setUserName] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [gazeSaveNote, setGazeSaveNote] = useState('')

  // Gaze state lives in refs, not React state, because samples arrive many times a
  // second via the tracker's callback and never need a re-render themselves.
  const gazeEnabledRef = useRef(false)
  const gazeSamplesRef = useRef<PageGazePoint[]>([])
  const trialGazeStatsRef = useRef<TrialGazeStats[]>([])
  const trialStartRef = useRef(0)
  // Gaze samples update a ref without re-rendering React. A lightweight
  // requestAnimationFrame loop below interpolates the blob between those
  // samples using compositor-only transforms, so lowering AI inference
  // frequency does not make its motion look lower-frame-rate.
  const gazeDotRef = useRef<HTMLDivElement | null>(null)
  const latestGazePointRef = useRef<PageGazePoint | null>(null)

  // Raw samples arrive only ~10x/sec (useGazeTracker.ts's
  // MIN_FRAME_INTERVAL_MS) and carry real spatial noise per sample, so two
  // consecutive samples can point in meaningfully different directions even
  // when gaze hasn't actually moved. Smoothing this *before* the speed-capped
  // chase below is what actually removes the jump-and-reverse look. The
  // speed cap alone only bounds how fast the dot can move, not how often its
  // target direction flips. Kept short: long enough to damp single-sample
  // noise, short enough that it isn't itself a second source of lag on top
  // of the speed cap below (100ms/px was: ~240ms here + the speed cap
  // compounding into up to ~1s to settle after a real eye jump).
  const smoothedTargetRef = useRef<{ x: number; y: number } | null>(null)
  const TARGET_SMOOTHING_MS = 90

  // What's actually drawn on screen chases the (now smoothed) gaze target at
  // a capped rate rather than snapping to it every tick. Eyes dart (saccades
  // move essentially instantly), and following that exactly is what read as
  // "darting"/sudden movement. Deliberately lagging behind fast eye motion,
  // rather than teleporting with it, is what makes this read as calm.
  // Separate ref from latestGazePointRef (which still holds the raw, un-
  // smoothed sample for e.g. trial scoring elsewhere). Raised from 1.1:
  // stacked with TARGET_SMOOTHING_MS above, the old value made real eye
  // jumps take close to a second to settle; this closes distance roughly
  // twice as fast once the (now faster-converging) smoothed target has
  // actually moved, while still not being an instant teleport.
  const displayedPosRef = useRef<{ x: number; y: number } | null>(null)
  const prevTickAtRef = useRef(0)
  const DISPLAY_MAX_SPEED_PX_MS = 2.2

  // Comet stretch: derived from the *displayed* (already speed-limited)
  // position's own motion, then smoothed further. See VELOCITY_SMOOTHING.
  const prevDisplayedPosRef = useRef<{ x: number; y: number } | null>(null)
  const smoothedVelRef = useRef({ x: 0, y: 0 })
  // Time-based smoothing behaves consistently on 60Hz and high-refresh
  // displays instead of depending on how frequently the callback happens.
  const VELOCITY_SMOOTHING_MS = 160
  // Below this fraction of DISPLAY_MAX_SPEED_PX_MS, treat as "not moving"
  // and hold a plain circle. Without this, residual jitter below the
  // smoothing floor still nudges scaleX/scaleY off 1 and makes the
  // (otherwise invisible-when-circular) rotation visible as a wobble.
  const SPEED_DEADZONE = 0.2
  // Pulled back down a bit from 0.6/0.2, which shortens the comet elongation
  // (the trail's actual length is this times the CSS gradient's own
  // baked-in asymmetry in index.css's gaze-blob-morph).
  const STRETCH_K = 0.48
  const SQUASH_K = 0.16

  const handleGazeSample = useCallback((result: GazeResult, capturedAt: number) => {
    const point = toPagePoint(result, capturedAt)
    if (point) {
      gazeSamplesRef.current.push(point)
      latestGazePointRef.current = point
    }
  }, [])

  // The blob runs across practice AND the real trials. Practice exists so
  // nothing about the measured trials is a first-time experience, and a gaze
  // indicator appearing out of nowhere the moment scoring starts would defeat
  // that. Derived into a boolean (rather than depending on `step` directly)
  // so the practice -> trials transition does NOT tear down and restart this
  // loop: the smoothing/velocity state below stays continuous across the
  // boundary instead of snapping the blob back to a cold start.
  const gazeActive = step === 'practice' || step === 'trials'

  useEffect(() => {
    if (!gazeActive || !gazeEnabledRef.current) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frameId = 0
    let lastConsumedPoint: PageGazePoint | null = null
    let rawTarget: { x: number; y: number } | null = null

    const animate = (now: number) => {
      frameId = window.requestAnimationFrame(animate)
      const point = latestGazePointRef.current
      const dot = gazeDotRef.current
      if (!point || !dot) return

      // Recalculate hit-testing only when a new inference sample arrives;
      // getBoundingClientRect on every display frame would needlessly force
      // repeated layout reads while the target has not changed.
      if (point !== lastConsumedPoint) {
        const targetRect = currentTargetRect()
        rawTarget =
          targetRect && isOnTarget(point, targetRect)
            ? {
                x: point.x * 0.4 + (targetRect.left + targetRect.width / 2) * 0.6,
                y: point.y * 0.4 + (targetRect.top + targetRect.height / 2) * 0.6,
              }
            : point
        lastConsumedPoint = point
      }
      if (!rawTarget) return

      const dt = prevTickAtRef.current ? now - prevTickAtRef.current : 0

      // Low-pass the raw target itself before chasing it. See
      // smoothedTargetRef's comment above for why this (not just the speed
      // cap below) is what fixes the glitchy jump-around look.
      const smoothed = smoothedTargetRef.current
      let smoothedTarget: { x: number; y: number }
      if (!smoothed || reduceMotion || dt <= 0) {
        smoothedTarget = rawTarget
      } else {
        const targetSmoothing = 1 - Math.exp(-dt / TARGET_SMOOTHING_MS)
        smoothedTarget = {
          x: smoothed.x + (rawTarget.x - smoothed.x) * targetSmoothing,
          y: smoothed.y + (rawTarget.y - smoothed.y) * targetSmoothing,
        }
      }
      smoothedTargetRef.current = smoothedTarget

      // Speed-limited follow: step the displayed position toward the
      // smoothed target by at most DISPLAY_MAX_SPEED_PX_MS * dt this tick.
      // First tick (or after a reduced-motion skip) just snaps once, since
      // there's nothing to lag behind yet.
      let showAt: { x: number; y: number }
      const cur = displayedPosRef.current
      if (!cur || reduceMotion || dt <= 0) {
        showAt = smoothedTarget
      } else {
        const dx = smoothedTarget.x - cur.x
        const dy = smoothedTarget.y - cur.y
        const dist = Math.hypot(dx, dy)
        const maxStep = DISPLAY_MAX_SPEED_PX_MS * dt
        showAt =
          dist <= maxStep ? smoothedTarget : { x: cur.x + (dx / dist) * maxStep, y: cur.y + (dy / dist) * maxStep }
      }
      displayedPosRef.current = showAt

      let normSpeed = 0
      let angleDeg = 0
      const prevDisplayed = prevDisplayedPosRef.current
      if (!reduceMotion && prevDisplayed && dt > 0) {
        const instVx = (showAt.x - prevDisplayed.x) / dt
        const instVy = (showAt.y - prevDisplayed.y) / dt
        const vel = smoothedVelRef.current
        const smoothing = 1 - Math.exp(-dt / VELOCITY_SMOOTHING_MS)
        vel.x += (instVx - vel.x) * smoothing
        vel.y += (instVy - vel.y) * smoothing
        const speedPxMs = Math.hypot(vel.x, vel.y)
        normSpeed = Math.min(1, speedPxMs / DISPLAY_MAX_SPEED_PX_MS)
        if (normSpeed < SPEED_DEADZONE) {
          normSpeed = 0
        } else {
          angleDeg = Math.atan2(vel.y, vel.x) * (180 / Math.PI)
        }
      }
      prevDisplayedPosRef.current = showAt
      prevTickAtRef.current = now

      dot.style.transform =
        `translate3d(${showAt.x}px, ${showAt.y}px, 0) translate(-50%, -50%) ` +
        `rotate(${angleDeg}deg) scaleX(${1 + normSpeed * STRETCH_K}) scaleY(${1 - normSpeed * SQUASH_K})`
      dot.style.opacity = '1'
    }

    frameId = window.requestAnimationFrame(animate)
    return () => {
      window.cancelAnimationFrame(frameId)
      displayedPosRef.current = null
      smoothedTargetRef.current = null
      prevDisplayedPosRef.current = null
      prevTickAtRef.current = 0
      smoothedVelRef.current = { x: 0, y: 0 }
    }
  }, [gazeActive])

  const tracker = useGazeTracker(handleGazeSample)

  // Every navigation goes through here so `direction` can never fall out of
  // sync with the step it is meant to describe.
  function go(next: Step, dir: 'forward' | 'back' = 'forward') {
    setDirection(dir)
    setStep(next)
  }

  function handleSkip() {
    markDismissed()
    go('skipped')
  }

  function enableCamera() {
    go('gazeCalibration')
  }

  function handleGazeCalibrationDone() {
    gazeEnabledRef.current = true
    go('practice')
  }

  // The practice run's own CalibrationTrial is discarded, never added to
  // `trials` and never submitted. See PRACTICE_TRIAL in trials.ts. Its gaze
  // samples are dropped too, and the trial clock only starts here, so the
  // first *measured* trial's window can't be polluted by however long
  // someone spent getting comfortable with the practice one.
  function handlePracticeComplete() {
    gazeSamplesRef.current = []
    trialStartRef.current = performance.now()
    go('trials')
  }

  // A correct trial click is a free, known (position, was-looking-here)
  // pair. Feeding it into the same registerCalibrationPoint used by the
  // 9-dot phase lets the mapping keep correcting itself as head position
  // drifts over the session, instead of only fitting once at the start.
  // x/y here are screen pixels (TrialTask's getBoundingClientRect); convert
  // to the tracker's viewport-normalized [-0.5, 0.5] convention, the
  // inverse of hitTest.ts's toPagePoint.
  //
  // maxSamples=4 summarises roughly the 400ms around the click, rather than
  // the whole ~800ms buffer a calibration dot uses: a dot is a sustained
  // fixation, whereas a click only tells you where the eye was at the moment
  // of clicking. It used to be 2 purely to keep WebEyeTrack.adapt()'s cost
  // down; that call is gone (see useGazeTracker.ts), so this is now chosen
  // for what makes the median robust rather than for what the main thread
  // could survive. Called directly, since registering a point is a 3x3 solve now,
  // so there is nothing left worth deferring off the click handler.
  function handleTargetHit(x: number, y: number) {
    if (!gazeEnabledRef.current) return
    const nx = x / window.innerWidth - 0.5
    const ny = y / window.innerHeight - 0.5
    tracker.registerCalibrationPoint(nx, ny, 4)
  }

  function handleGazeCalibrationError(message: string) {
    console.warn('[Distill] gaze calibration failed, continuing without camera:', message)
    tracker.stop()
    gazeEnabledRef.current = false
    go('practice')
  }

  function handleTrialComplete(outcome: CalibrationTrial) {
    console.log('[Distill] trial complete', outcome)
    if (gazeEnabledRef.current) {
      const trialEnd = performance.now()
      const windowSamples = gazeSamplesRef.current.filter(
        (s) => s.capturedAt >= trialStartRef.current && s.capturedAt <= trialEnd,
      )
      trialGazeStatsRef.current.push(computeTrialGazeStats(windowSamples, trialStartRef.current))
      trialStartRef.current = trialEnd
    }

    const next = [...trials, outcome]
    setTrials(next)
    if (trialIndex + 1 < TRIALS.length) {
      setTrialIndex(trialIndex + 1)
    } else {
      submit(next)
    }
  }

  async function submit(finishedTrials: CalibrationTrial[]) {
    // Camera is no longer needed once trials are done, win or lose.
    if (gazeEnabledRef.current) tracker.stop()

    setStep('submitting')
    setError('')
    try {
      const gazeSummary: GazeSummary = gazeEnabledRef.current
        ? combineGazeStats(trialGazeStatsRef.current)
        : { enabled: false }
      const response = await fetch(`${BACKEND_URL}/v1/calibration/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trials: finishedTrials, gazeSummary }),
      })
      if (!response.ok) {
        throw new Error(`Backend returned ${response.status}`)
      }
      const data = (await response.json()) as CalibrationProfileResponse
      console.log('[Distill] calibration profile result', data)
      await storeResult(data, userName)
      setResult(data)
      setStep('results')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep('error')
    }
  }

  function retrySubmit() {
    submit(trials)
  }

  // Skips the entire wizard by replaying a previously saved run. The camera
  // is never started on this path, so there is nothing to stop here.
  async function handleCalibrationFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const picked = input.files?.[0]
    // Cleared before anything else so re-picking the SAME path fires `change`
    // again. Chrome suppresses the event when the value is unchanged, which
    // otherwise makes the second load of a file you just re-exported look
    // like a dead button.
    input.value = ''
    if (!picked) return

    setImportError('')
    const parsed = parseCalibrationFile(await picked.text())
    if (!parsed.ok) {
      setImportError(`Couldn't load that file (${parsed.error}).`)
      return
    }

    const response: CalibrationProfileResponse = {
      profile: parsed.file.profile,
      explanation: parsed.file.explanation,
    }
    try {
      await storeResult(response, userName)
    } catch (err) {
      // Reported rather than swallowed: without the storage write the profile
      // exists only in this tab's memory, so the extension would carry on
      // using its defaults while the results screen implied otherwise.
      setImportError(`Loaded that file, but couldn't save it to the extension: ${String(err)}`)
      return
    }
    setResult(response)
    setImportedFromFile(true)
    setStep('results')
  }

  function handleSaveCalibrationFile() {
    if (!result) return
    downloadCalibrationFile(buildCalibrationFile(result.profile, result.explanation))
  }

  // Writes out the eye -> screen mapping the dot phase just produced, so the
  // next run can load it instead of sitting through nine dots again.
  function handleSaveGazeCalibration() {
    const pairs = tracker.getCalibrationPairs()
    // Prefer the mapping actually in use over refitting: they agree, but
    // saving the live one means the file is exactly what was on screen.
    const matrix = tracker.getGazeCorrection() ?? fitAffine(pairs)
    if (!matrix) {
      setGazeSaveNote(
        `Couldn't fit a mapping from ${pairs.length} point${pairs.length === 1 ? '' : 's'}. Redo the dots with your face in frame.`,
      )
      return
    }
    downloadGazeCalibrationFile(buildGazeCalibrationFile(pairs, matrix))
    // Residual is the honest quality signal here: a mapping can always be
    // fitted, but one fitted through scattered points will put the blob in
    // the wrong place, and that is much cheaper to notice now than after a
    // calibration that quietly maps gaze to the wrong part of the screen.
    const meanError = residualError(matrix, pairs)
    setGazeSaveNote(
      `Saved ${pairs.length} points · mean error ${(meanError * 100).toFixed(1)}% of the viewport${
        meanError > 0.12 ? ', which is high, so consider redoing the dots' : ''
      }.`,
    )
  }

  // Renders the per-step screen. Kept as a nested function (rather than
  // inline in the final return) so the <video> element below can sit
  // outside this step-conditional entirely. It must stay mounted across
  // the 'gazeCalibration' -> 'trials' transition (see GAZE_VIDEO_ID's
  // comment in useGazeTracker.ts), which an early-return per step here
  // would otherwise defeat by unmounting the whole tree on every step change.
  function renderStep() {
  if (step === 'welcome') {
    return (
      <WelcomeScreen
        onStart={() => go('name')}
        onSkip={handleSkip}
        onLoadProfile={() => fileInputRef.current?.click()}
        importError={importError}
        direction={direction}
      />
    )
  }

  if (step === 'name') {
    return (
      <NameScreen
        userName={userName}
        onUserNameChange={setUserName}
        onContinue={() => go('camera')}
        onBack={() => go('welcome', 'back')}
      />
    )
  }

  if (step === 'camera') {
    return (
      <Shell showGlow animKey="camera" direction={direction} progress={1}>
        <Reveal delay={0}>
          <h1 className="hero-title text-display font-semibold">
            {userName.trim() ? `${userName.trim()}, one optional step` : 'One optional step'}
          </h1>
        </Reveal>
        <Reveal delay={80}>
          <p className="text-body text-on-surface-variant">
            Distill can use your camera to see where you're looking during the tasks below, which makes the result
            more specific to you. For example, it can notice if your attention keeps drifting to distracting elements.
            Nothing is ever recorded or sent anywhere; it's only used live, on this page, to score the tasks.
          </p>
        </Reveal>
        <Reveal delay={160}>
          <div className="flex flex-wrap justify-center gap-3">
            <PrimaryButton onClick={enableCamera}>Enable camera</PrimaryButton>
            <SecondaryButton onClick={() => go('practice')}>Continue without camera</SecondaryButton>
          </div>
        </Reveal>
      </Shell>
    )
  }

  if (step === 'gazeCalibration') {
    return (
      <DotCalibration
        tracker={tracker}
        onDone={handleGazeCalibrationDone}
        onError={handleGazeCalibrationError}
      />
    )
  }

  if (step === 'practice') {
    return (
      <Shell wide animKey="practice" direction={direction} progress={3}>
        <p className="text-meta font-semibold tracking-[0.08em] text-on-surface-variant uppercase">Practice</p>
        <h1 className="text-title font-semibold text-on-background">Let's try one first</h1>
        <p className="max-w-md text-body text-on-surface-variant">
          This one isn't scored. It's just so the real tasks aren't the first time you've seen this. Take as long
          as you like.
        </p>
        <TrialTask
          key={PRACTICE_TRIAL.id}
          trial={PRACTICE_TRIAL}
          onComplete={handlePracticeComplete}
          onTargetHit={handleTargetHit}
          isPractice
        />
        {/* Development affordance, placed here because this is the first
            pause after the dot phase: the mapping exists, and the camera is
            still running. Hidden when the mapping was itself loaded from a
            file, since re-saving it would just round-trip the same numbers. */}
        {gazeEnabledRef.current && !tracker.isCorrectionFromFile() && (
          <div className="flex flex-col items-center gap-2 border-t border-outline pt-4">
            <QuietButton onClick={handleSaveGazeCalibration}>
              <Icon name="download" />
              Save this eye calibration
            </QuietButton>
            {gazeSaveNote && <p className="max-w-sm text-meta text-on-surface-variant">{gazeSaveNote}</p>}
          </div>
        )}
      </Shell>
    )
  }

  if (step === 'trials') {
    return (
      // Keyed per trial, not just per step, so each new task slides in the
      // same way every other screen change does.
      <Shell wide animKey={`trial-${trialIndex}`} direction="forward" progress={4}>
        <p className="text-meta font-semibold tracking-[0.08em] text-on-surface-variant uppercase">
          Task {trialIndex + 1} of {TRIALS.length}
        </p>
        <TrialTask
          key={TRIALS[trialIndex].id}
          trial={TRIALS[trialIndex]}
          onComplete={handleTrialComplete}
          onTargetHit={handleTargetHit}
        />
      </Shell>
    )
  }

  if (step === 'submitting') {
    return (
      <Shell animKey="submitting">
        <Icon name="spinner" className="h-6 w-6 animate-spin text-accent-text" />
        <p className="text-body text-on-surface-variant">Analyzing your results…</p>
      </Shell>
    )
  }

  if (step === 'error') {
    return (
      <Shell animKey="error">
        <h1 className="text-title font-semibold text-on-background">Couldn't reach Distill's backend</h1>
        <p className="text-meta text-danger-text">{error}</p>
        <p className="text-body text-on-surface-variant">
          Make sure the backend is running, or skip for now. You can redo this anytime.
        </p>
        <div className="flex gap-3">
          <PrimaryButton onClick={retrySubmit}>Try again</PrimaryButton>
          <SecondaryButton onClick={handleSkip}>Skip for now</SecondaryButton>
        </div>
      </Shell>
    )
  }

  if (step === 'skipped') {
    return (
      <Shell showGlow animKey="skipped">
        <h1 className="hero-title text-display font-semibold">No problem</h1>
        <p className="text-body text-on-surface-variant">
          Distill will use sensible defaults. You can close this tab, and the "Finish setup" reminder in the extension
          popup will bring you back here anytime.
        </p>
        <PrimaryButton onClick={() => window.close()}>Close this tab</PrimaryButton>
      </Shell>
    )
  }

  // results
  return (
    <Shell showGlow animKey="results">
      <Reveal delay={0}>
        <div className="flex items-center gap-2 text-accent-text">
          <Icon name="check" />
          <h1 className="hero-title text-display font-semibold">
            {importedFromFile
              ? 'Calibration loaded'
              : userName.trim()
                ? `You're all set, ${userName.trim()}`
                : "You're all set"}
          </h1>
        </div>
      </Reveal>
      {importedFromFile && (
        <Reveal delay={60}>
          <p className="text-body text-on-surface-variant">
            Restored from a saved file, so the tasks were skipped.
          </p>
        </Reveal>
      )}
      <ul className="flex w-full flex-col gap-2 text-left">
        {/* The stagger is applied to the <li> directly rather than through
            <Reveal>, whose wrapper <div> would not be a valid child of <ul>. */}
        {result?.explanation.map((line, i) => (
          <li
            key={line}
            style={{ '--delay': `${120 + i * 70}ms` } as React.CSSProperties}
            className="reveal rounded-md border border-outline bg-surface px-4 py-3 text-body text-on-surface"
          >
            {line}
          </li>
        ))}
      </ul>
      <div className="flex flex-col items-center gap-3">
        <PrimaryButton onClick={() => window.close()}>Close this tab</PrimaryButton>
        <QuietButton onClick={handleSaveCalibrationFile}>
          <Icon name="download" />
          Save profile file
        </QuietButton>
        <p className="max-w-sm text-meta text-on-surface-muted">
          Saves the finished profile as a .json you can load from the first screen to skip the whole wizard. Separate
          from the eye calibration file, which only stores the gaze mapping and still runs the tasks.
        </p>
      </div>
    </Shell>
  )
  }

  // The camera feed itself: must stay mounted for the tracker's whole
  // lifetime (see GAZE_VIDEO_ID's comment in useGazeTracker.ts), so it lives
  // here rather than inside any per-step screen. Visible in the corner only
  // during calibration, visually hidden (but still playing) afterwards.
  return (
    <>
      <video
        id={GAZE_VIDEO_ID}
        autoPlay
        muted
        playsInline
        className={
          step === 'gazeCalibration' ? 'fixed top-4 right-4 h-24 w-32 rounded-md object-cover' : 'sr-only'
        }
      />
      {/* Out here with the <video> so the element the welcome screen's load
          button clicks through to always exists, independent of which step is
          rendered. `hidden` rather than sr-only: this is never something to
          reach directly, only via that button. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleCalibrationFileChosen}
      />
      {gazeActive && gazeEnabledRef.current && (
        // Lives out here, alongside the <video>, for the same reason it does:
        // it has to stay mounted across the practice -> trials step change.
        // Rendered inside either step's own screen it would be a different
        // subtree per step, so React would unmount and remount it at the
        // boundary, resetting the opacity transition (a visible flicker)
        // right as scoring begins.
        //
        // Outer div: position + velocity only (JS-written transform every
        // animation frame, see the effect above). Inner div: the organic
        // morph animation (gaze-blob-morph, index.css), kept on a separate
        // element so the two animations don't fight over the same style
        // properties. Pulled back down from 350px (too big) to 256px, still
        // bigger than hitTest.ts's own ~85-90px gaze error estimate, so it
        // still honestly reads as an uncertainty blob, not a precise cursor.
        // Cyan, not accent's blue (#2f6fb5), because the target shape itself is
        // bg-accent, so the gaze indicator needs a visibly different hue to
        // stay distinguishable from what's actually being clicked.
        <div
          ref={gazeDotRef}
          aria-hidden="true"
          // Position/stretch are written once per animation frame. Only
          // opacity is transitioned; transitioning transform as well would
          // restart a second interpolation on every frame and reintroduce
          // the stutter this loop is designed to remove.
          className="pointer-events-none fixed top-0 left-0 z-50 h-64 w-64 opacity-0 transition-opacity duration-200 ease-out will-change-transform"
        >
          <div className="gaze-blob-morph absolute inset-0" />
        </div>
      )}
      {renderStep()}
    </>
  )
}

export default App
