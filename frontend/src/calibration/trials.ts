// Fixed 5-trial calibration sequence. Each trial's `condition` string and
// `objectCount` are chosen to line up exactly with the backend's rule
// matching in backend/services/profile_rules.py:
//   - clutter rule buckets ALL trials by objectCount (<=6 vs >6)
//   - spacing/contrast/motion rules compare a "baseline" bucket (condition
//     null, or containing "baseline") against a bucket matching "spac" /
//     "contrast" / "motion" respectively
//
// baseline-low + baseline-high together feed the clutter rule and serve as
// the baseline bucket the other three trials get compared against.

export type TrialVariant = 'plain' | 'spacing' | 'contrast' | 'motion'

export interface TrialConfig {
  id: string
  // null matches the backend's "condition is None" baseline bucket.
  condition: string | null
  objectCount: number
  variant: TrialVariant
  instructions: string
}

// Raised from 15s. This is a backstop against a trial hanging forever, not a
// speed test - the profile rules only ever compare completion times between
// conditions, so nobody's absolute time matters and there is no reason to
// squeeze it. 15s was tight enough that a user who needed a moment to orient
// (exactly the audience this extension is built for) got silently recorded as
// a failure. Deliberately never shown as a countdown: a visible timer is its
// own source of pressure. NUDGE_AFTER_MS below is the visible affordance
// instead.
export const TRIAL_TIMEOUT_MS = 20000

// When to offer a way out, rather than letting someone sit stuck until the
// timeout fires. An explicit skip is also better data than a timeout: both
// record success:false, but a skip means they gave up, while a timeout can
// just mean they were still working when the clock ran out.
export const NUDGE_AFTER_MS = 10000

// Untimed, never submitted, never scored - it exists purely so the first
// *measured* trial isn't also the one where the user is still working out
// what the task is. baseline-low is the bucket every other condition gets
// compared against (profile_rules.py's _is_baseline), so contaminating it
// with first-time confusion skews the spacing, contrast AND motion rules at
// once. Same shape as a real trial so the practice actually transfers.
export const PRACTICE_TRIAL: TrialConfig = {
  id: 'practice',
  condition: null,
  objectCount: 4,
  variant: 'plain',
  instructions: 'Find the blue circle and click it.',
}

export const TRIALS: TrialConfig[] = [
  {
    id: 'baseline-low',
    condition: null,
    objectCount: 4,
    variant: 'plain',
    instructions: 'Find the blue circle and click it.',
  },
  {
    id: 'baseline-high',
    condition: null,
    objectCount: 10,
    variant: 'plain',
    instructions: 'Find the blue circle and click it.',
  },
  {
    id: 'spacing',
    condition: 'increasedSpacing',
    objectCount: 10,
    variant: 'spacing',
    instructions: 'Same task — the shapes have more room this time.',
  },
  {
    id: 'contrast',
    condition: 'enhancedContrast',
    objectCount: 10,
    variant: 'contrast',
    instructions: 'Same task — the blue circle stands out more this time.',
  },
  {
    id: 'motion',
    condition: 'reducedMotion',
    objectCount: 10,
    variant: 'motion',
    instructions: 'Same task — some shapes drift around. Just find the blue one.',
  },
]
