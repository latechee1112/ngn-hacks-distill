// Profile resolution shared by the content script (which *applies* a profile)
// and the popup (which *displays* one). Both need the same three-tier answer,
// and they must not disagree: a popup card claiming "Calibrated to Sam" while
// the page was simplified with defaults is worse than no card at all.
//
// Lives in shared/ rather than under content/ for that reason - the popup has
// no DOM to extract and must not pull the content script's modules in just to
// read a stored profile.

import type { VisualProfile } from '../types/analysis'
import { CALIBRATION_STORAGE_KEY, type StoredCalibration } from '../types/calibration'
import { loadUsageProfile } from './usageProfile'

// Used whenever nothing has been calibrated and browsing has not yet produced
// enough signal.
export const DEFAULT_PROFILE: VisualProfile = {
  profileId: 'default-profile',
  maxVisibleBlocks: 6,
  spacingMultiplier: 1.4,
  textScale: 1.15,
  contrastMode: 'enhanced',
  // Off by default - a real OS-level "prefers-reduced-motion" preference still
  // suppresses motion independently (see scanAnimation.ts's
  // prefersReducedMotion()), so this only controls Distill's own opinion, not
  // actual accessibility. Defaulting it on suppressed the scan-sweep animation
  // for every uncalibrated user.
  reduceMotion: false,
  progressiveReveal: false,
  simplificationStrength: 0.6,
  source: 'default',
}

// The calibration wizard (src/calibration/App.tsx) writes its result to
// chrome.storage.local, keyed globally rather than per-site.
export async function loadStoredCalibration(): Promise<StoredCalibration | null> {
  try {
    const stored = await chrome.storage.local.get(CALIBRATION_STORAGE_KEY)
    return (stored?.[CALIBRATION_STORAGE_KEY] as StoredCalibration | undefined) ?? null
  } catch {
    return null
  }
}

export async function loadCalibratedProfile(): Promise<VisualProfile | null> {
  return (await loadStoredCalibration())?.profile ?? null
}

// Where a resolved profile came from, so callers can describe it honestly
// instead of assuming it was calibrated.
export interface ResolvedProfile {
  profile: VisualProfile
  origin: 'calibration' | 'usage' | 'default'
  // Present only for a calibration that recorded one. Display label only.
  userName?: string
  // The rules that fired, from the backend's calibration response or the local
  // usage derivation. Empty for the default profile, which explains itself.
  explanation: string[]
}

// Three tiers, most-earned first:
//   1. Calibration - the user sat through the wizard. Measured under controlled
//      conditions with known decoys, so it outranks everything below.
//   2. Usage - derived from ordinary browsing (see usageProfile.ts). Only
//      returned once there is enough evidence to mean anything.
//   3. DEFAULT_PROFILE - nothing observed yet.
export async function resolveProfile(): Promise<ResolvedProfile> {
  const stored = await loadStoredCalibration()
  if (stored?.profile) {
    return {
      profile: stored.profile,
      origin: 'calibration',
      userName: stored.userName,
      explanation: stored.explanation ?? [],
    }
  }

  const usage = await loadUsageProfile()
  if (usage) {
    return { profile: usage.profile, origin: 'usage', explanation: usage.explanation }
  }

  return { profile: DEFAULT_PROFILE, origin: 'default', explanation: [] }
}
