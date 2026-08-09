import { useEffect, useRef, useState } from 'react'
import type { CalibrationTrial } from '../types/calibration'
import Decoys from './gaze/Decoys'
import { NUDGE_AFTER_MS, TRIAL_TIMEOUT_MS, type TrialConfig } from './trials'

interface Shape {
  index: number
  isTarget: boolean
}

// Marks the one correct shape, for gaze hit-testing to find (hitTest.ts's
// currentTargetRect). Deliberately a data- attribute rather than the
// aria-label this replaced: that label announced "Target shape" vs
// "Distractor shape" to a screen reader, which handed over the answer to a
// visual-search task and corrupted the very measurement being scored. Both
// shapes now carry an identical accessible name, so nothing leaks through the
// accessibility tree. Exported (rather than duplicated as a string literal in
// hitTest.ts) so the markup and the selector can't drift apart - same pattern
// as Decoys.tsx's exported element ids.
export const TARGET_ATTR = 'data-distill-target'
export const TARGET_SELECTOR = `[${TARGET_ATTR}="true"]`

function buildShapes(count: number): Shape[] {
  const targetIndex = Math.floor(Math.random() * count)
  return Array.from({ length: count }, (_, index) => ({ index, isTarget: index === targetIndex }))
}

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-surface-variant focus-visible:ring-offset-2 focus-visible:ring-offset-background'

function TrialTask({
  trial,
  onComplete,
  onTargetHit,
  isPractice = false,
}: {
  trial: TrialConfig
  onComplete: (result: CalibrationTrial) => void
  // Fired only on a correct target click, with that button's on-screen
  // center - a free, known (position, was-looking-here) pair App.tsx feeds
  // into live recalibration. Never fired for decoy/wrong-shape clicks,
  // since only a correct hit reliably means the gaze was actually there.
  onTargetHit?: (x: number, y: number) => void
  // Practice runs are untimed and their result is discarded by the caller.
  isPractice?: boolean
}) {
  // App.tsx mounts a fresh TrialTask per trial (key={trial.id}), so these only
  // ever need to be computed once per mount - no reset-on-prop-change effect.
  const [shapes] = useState<Shape[]>(() => buildShapes(trial.objectCount))
  // Refs, not state: click/timeout handlers need the current count and a
  // one-shot guard without waiting on a re-render.
  const errorsRef = useRef(0)
  const decoyClicksRef = useRef(0)
  const startRef = useRef(performance.now())
  const doneRef = useRef(false)
  // State, not a ref: this one has to actually re-render to appear.
  const [showNudge, setShowNudge] = useState(false)

  useEffect(() => {
    const nudge = window.setTimeout(() => setShowNudge(true), NUDGE_AFTER_MS)
    // Practice is untimed on purpose - it is never scored or submitted, so a
    // clock would only add pressure with nothing to protect. The nudge above
    // still offers a way forward for someone who is stuck.
    const timeout = isPractice ? null : window.setTimeout(() => finish(false), TRIAL_TIMEOUT_MS)
    return () => {
      window.clearTimeout(nudge)
      if (timeout !== null) window.clearTimeout(timeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function finish(success: boolean) {
    if (doneRef.current) return
    doneRef.current = true
    onComplete({
      objectCount: trial.objectCount,
      completionTimeMs: performance.now() - startRef.current,
      errorCount: errorsRef.current,
      distractorClickCount: decoyClicksRef.current,
      condition: trial.condition,
      success,
    })
  }

  function handleClick(shape: Shape, event: React.MouseEvent<HTMLButtonElement>) {
    if (doneRef.current) return
    console.log('[Distill] shape click', { index: shape.index, isTarget: shape.isTarget })
    if (shape.isTarget) {
      const rect = event.currentTarget.getBoundingClientRect()
      onTargetHit?.(rect.left + rect.width / 2, rect.top + rect.height / 2)
      finish(true)
    } else {
      errorsRef.current += 1
    }
  }

  function handleDecoyClick() {
    if (doneRef.current) return
    decoyClicksRef.current += 1
    console.log('[Distill] decoy click', { count: decoyClicksRef.current })
  }

  // Everything is spread out now, per an explicit request to stop any trial
  // reading as cramped. Both values moved up together (20 -> 48, 48 -> 80)
  // specifically so a delta survives: profile_rules.py's _apply_spacing_rule
  // needs the spaced condition to beat baseline by >=15% completion time, and
  // this pair is the sole source of that contrast, so levelling them would
  // disable the rule outright and pin spacingMultiplier at its 1.15 default.
  // Worth knowing regardless: a baseline this generous is already easy to
  // scan, so the *marginal* gain from the extra spacing is smaller than it
  // was, and the rule will fire less often than with a tight baseline. That
  // is a real sensitivity cost, accepted deliberately in exchange for no
  // trial ever feeling cramped.
  // 5 x 64px + 4 x 80px = 640px at the widest, inside Shell's wide (768px)
  // container.
  const gapClass = trial.variant === 'spacing' ? 'gap-20' : 'gap-12'

  return (
    <div className="flex flex-col items-center gap-8">
      <Decoys onDecoyClick={handleDecoyClick} />
      <p className="max-w-md text-body text-on-surface">{trial.instructions}</p>
      <div className={`grid grid-cols-5 ${gapClass}`}>
        {shapes.map((shape) => (
          <button
            key={shape.index}
            type="button"
            onClick={(e) => handleClick(shape, e)}
            // Identical for every shape - see TARGET_ATTR above.
            aria-label="Shape"
            {...(shape.isTarget ? { [TARGET_ATTR]: 'true' } : {})}
            // The target's pulse animates transform, so it replaces the hover
            // scale rather than stacking with it - a CSS animation wins over a
            // transition on the same property, so keeping both would just mean
            // a hover state that silently never applies.
            className={`h-16 w-16 rounded-full ${FOCUS_RING} ${
              shape.isTarget ? 'trial-target-pulse' : 'transition-transform hover:scale-105'
            } ${
              shape.isTarget
                ? `bg-accent ${trial.variant === 'contrast' ? 'ring-4 ring-accent-text ring-offset-2 ring-offset-background' : ''}`
                : trial.variant === 'contrast'
                  ? 'border border-outline bg-surface'
                  : 'bg-outline-strong'
            } ${trial.variant === 'motion' && !shape.isTarget ? 'animate-[trial-drift_1.6s_ease-in-out_infinite]' : ''}`}
            style={
              trial.variant === 'motion' && !shape.isTarget
                ? { animationDelay: `${(shape.index % 5) * 120}ms` }
                : undefined
            }
          />
        ))}
      </div>
      {/* Fixed-height slot, always rendered. The nudge appears mid-trial, and
          letting it grow the column would shift the shape grid - moving the
          target out from under a cursor already on its way to it, and
          invalidating the completion time being measured. */}
      <div className="flex h-16 items-start justify-center" aria-live="polite">
        {showNudge && !doneRef.current && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-meta text-on-surface-variant">Still looking? There's no rush.</p>
            <button
              type="button"
              onClick={() => finish(false)}
              className={`rounded-md border border-outline bg-surface px-4 py-2 text-meta font-medium text-on-surface transition-colors hover:bg-surface-hover ${FOCUS_RING}`}
            >
              {isPractice ? 'Skip practice' : 'Skip this one'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default TrialTask
