// Wire contract with the backend's calibration models (backend/models/calibration.py).
// Field names and shape must match exactly.

import type { VisualProfile } from './analysis'

export interface CalibrationTrial {
  objectCount?: number
  completionTimeMs?: number
  errorCount?: number
  // Clicks on the decoy sidebar/ad shown alongside every trial. Direct
  // behavioral evidence for the backend's decoy-distraction rule.
  distractorClickCount?: number
  // baseline | increasedSpacing | enhancedContrast | reducedMotion | ...
  condition?: string | null
  success?: boolean
}

export interface GazeSummary {
  enabled: boolean
  sampleCount?: number
  averageDispersion?: number
  averageTargetAcquisitionMs?: number
  distractorGazeRatio?: number
}

export interface ManualPreferences {
  reduceMotion?: boolean
  progressiveReveal?: boolean
}

export interface CalibrationRequest {
  trials: CalibrationTrial[]
  gazeSummary?: GazeSummary
  manualPreferences?: ManualPreferences
}

export interface CalibrationProfileResponse {
  profile: VisualProfile
  explanation: string[]
}

// chrome.storage.local key the calibration wizard writes to and the content
// script reads from. Local (not sync) and keyed globally, not per-site,
// because the whole point is that it applies no matter what page you're on.
export const CALIBRATION_STORAGE_KEY = 'distillCalibrationProfile'

// What the user asked to be called, from the wizard's name screen. Optional
// throughout: it is a display label for the popup's profile card and nothing
// reads it to make a decision, so every consumer must render a sensible card
// without it (a profile loaded from a file or derived from browsing has none).
export const USER_NAME_MAX_LENGTH = 40

export interface StoredCalibration {
  profile?: VisualProfile
  explanation?: string[]
  completedAt?: number
  userName?: string
  // Set when the user explicitly skips, so the popup's "Finish setup"
  // banner doesn't nag every time it's reopened.
  dismissed: boolean
}
