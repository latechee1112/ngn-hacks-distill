// The passively-derived visual profile: storage shape, and the deterministic
// rules that turn accumulated browsing counters into a VisualProfile.
//
// Split out of content/usageTracker.ts so this can be imported by pages that
// have no DOM to observe - the popup reads a profile to *display* it, and must
// not pull the content script's collection machinery (and its dom-heuristics
// dependency) into its bundle to do that. Collection lives in usageTracker.ts;
// everything here is pure apart from the two chrome.storage calls.
//
// The calibration wizard measures the same three things this does - how much
// clutter costs you, where your attention leaks to, and whether you read or
// skim - just under controlled conditions with synthetic decoys. So the rules
// below deliberately mirror backend/services/profile_rules.py: a distractor
// gate, an attention-leak gate, and a skim gate, each with its own explanation
// string. Nothing here is a model; every field traces to a counter and a
// threshold.
//
// PRIVACY: only integer counters are ever stored. No URLs, no element text, no
// per-site breakdown, no timestamps beyond a single updatedAt. What is kept
// cannot identify a page that was visited, only that (say) 31% of clicks in
// aggregate landed on page furniture.

import type { VisualProfile } from '../types/analysis'

export const USAGE_STORAGE_KEY = 'distill.usageSignals'
export const USAGE_SIGNALS_VERSION = 1

export interface UsageSignals {
  version: number
  updatedAt: number
  // Foreground-visible time, split by whether the region is reading content or
  // page furniture. The ratio is the signal; absolute totals are not used.
  dwellMsContent: number
  dwellMsPeripheral: number
  // A region that came into view and left again quickly (skimmed past) vs one
  // that stayed long enough to have actually been read.
  glanceCount: number
  readCount: number
  clickCount: number
  // Clicks that landed on an ad, a rail, a sticky promo or nav - the in-the-wild
  // equivalent of the calibration wizard's decoy sidebar/ad.
  distractorClickCount: number
}

export const EMPTY_SIGNALS: UsageSignals = {
  version: USAGE_SIGNALS_VERSION,
  updatedAt: 0,
  dwellMsContent: 0,
  dwellMsPeripheral: 0,
  glanceCount: 0,
  readCount: 0,
  clickCount: 0,
  distractorClickCount: 0,
}

// Below this, the ratios are noise and deriveUsageProfile() returns null - the
// caller then falls back to DEFAULT_PROFILE. Roughly a few minutes of browsing.
export const MIN_INTERACTIONS = 25

// Mirrors profile_rules.py's _DECOY_CLICK_RATE_THRESHOLD in intent: direct
// behavioral evidence, so it is allowed to move maxVisibleBlocks on its own.
const DISTRACTOR_CLICK_RATIO = 0.25
// Attention leaking to furniture. Softer evidence than a click (you can look at
// a rail without it costing you anything), so it only adds strength.
const PERIPHERAL_DWELL_RATIO = 0.35
// Mostly glancing rather than reading - progressive reveal is for this user.
const GLANCE_RATIO = 0.6

export async function loadUsageSignals(): Promise<UsageSignals> {
  try {
    const stored = await chrome.storage.local.get(USAGE_STORAGE_KEY)
    const record = stored?.[USAGE_STORAGE_KEY] as Partial<UsageSignals> | undefined
    if (!record || record.version !== USAGE_SIGNALS_VERSION) return { ...EMPTY_SIGNALS }
    return { ...EMPTY_SIGNALS, ...record, version: USAGE_SIGNALS_VERSION }
  } catch {
    return { ...EMPTY_SIGNALS }
  }
}

export async function clearUsageSignals(): Promise<void> {
  try {
    await chrome.storage.local.remove(USAGE_STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}

export interface UsageProfileResult {
  profile: VisualProfile
  explanation: string[]
}

export function totalInteractions(signals: UsageSignals): number {
  return signals.clickCount + signals.readCount + signals.glanceCount
}

// Returns null until there is enough evidence to say anything. The caller falls
// back to DEFAULT_PROFILE in that case, so an under-observed user is never given
// a profile invented out of three data points.
export function deriveUsageProfile(signals: UsageSignals): UsageProfileResult | null {
  if (totalInteractions(signals) < MIN_INTERACTIONS) return null

  const explanation: string[] = []

  const distractorRatio = signals.clickCount > 0 ? signals.distractorClickCount / signals.clickCount : 0
  const totalDwell = signals.dwellMsContent + signals.dwellMsPeripheral
  const peripheralRatio = totalDwell > 0 ? signals.dwellMsPeripheral / totalDwell : 0
  const viewed = signals.readCount + signals.glanceCount
  const glanceRatio = viewed > 0 ? signals.glanceCount / viewed : 0

  const clutterSensitive = distractorRatio >= DISTRACTOR_CLICK_RATIO
  const attentionLeaks = peripheralRatio >= PERIPHERAL_DWELL_RATIO
  const skims = glanceRatio >= GLANCE_RATIO

  if (clutterSensitive) {
    explanation.push(
      `${Math.round(distractorRatio * 100)}% of clicks landed on ads, rails or navigation rather than page content.`,
    )
  }
  if (attentionLeaks) {
    explanation.push(
      `${Math.round(peripheralRatio * 100)}% of on-screen time was spent on page furniture rather than the main content.`,
    )
  }
  if (skims) {
    explanation.push(
      `${Math.round(glanceRatio * 100)}% of sections were scrolled past rather than read - revealing content a section at a time.`,
    )
  }
  if (explanation.length === 0) {
    explanation.push('Browsing showed no strong clutter sensitivity; using conservative baseline settings.')
  }

  // Same shape and same numbers as profile_rules.py's outputs, so a usage
  // profile and a calibration profile are interchangeable downstream.
  let simplificationStrength = 0.4
  if (clutterSensitive) simplificationStrength += 0.15
  if (attentionLeaks) simplificationStrength += 0.1
  if (skims) simplificationStrength += 0.05
  simplificationStrength = Math.min(1, Number(simplificationStrength.toFixed(2)))

  return {
    profile: {
      profileId: `usage-${signals.updatedAt || Date.now()}`,
      maxVisibleBlocks: clutterSensitive || attentionLeaks ? 6 : 10,
      spacingMultiplier: 1.15,
      textScale: 1.0,
      contrastMode: 'standard',
      reduceMotion: false,
      progressiveReveal: skims || clutterSensitive,
      simplificationStrength,
      source: 'usage',
    },
    explanation,
  }
}

export async function loadUsageProfile(): Promise<UsageProfileResult | null> {
  return deriveUsageProfile(await loadUsageSignals())
}
