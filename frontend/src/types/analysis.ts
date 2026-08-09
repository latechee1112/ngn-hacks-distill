// Wire contract with the backend's response models (backend/models/analysis.py,
// backend/models/profile.py). Field names and shape must match exactly.

export type BlockActionType = 'emphasize' | 'keep' | 'deemphasize' | 'collapse'

export interface BlockAction {
  blockId: string
  action: BlockActionType
  priority: number
  reason: string
}

export interface LayoutSettings {
  maxVisibleBlocks: number
  spacingMultiplier: number
  textScale: number
  reduceMotion: boolean
  progressiveReveal: boolean
}

export interface AnalyzePageResponse {
  analysisId: string
  summary: string
  actions: BlockAction[]
  layout: LayoutSettings
  warnings: string[]
}

export interface VisualProfile {
  profileId: string
  maxVisibleBlocks: number
  spacingMultiplier: number
  textScale: number
  preferredRegion?: 'left' | 'right' | 'center' | 'top'
  contrastMode: 'standard' | 'enhanced'
  reduceMotion: boolean
  progressiveReveal: boolean
  simplificationStrength: number
  // 'usage' is the passively-derived profile (see content/usageTracker.ts):
  // same shape and same downstream treatment as a calibrated one, just built
  // from ordinary browsing instead of the wizard.
  source: 'calibration' | 'usage' | 'manual' | 'default'
}

export type AnalyzeBackendResult =
  | { ok: true; data: AnalyzePageResponse }
  | { ok: false; error: string }

// Reply to DISTILL_SIMPLIFY. `ok: false` is a real outcome, not an absent reply:
// the pre-filter mutates the page before anything can throw, so a failure that
// answered with silence would leave the panel waiting forever on a page it had
// already changed.
export type SimplifyResponse =
  | { ok: true; primaryFound: boolean; deemphasizedCount: number; adsHidden: number }
  | { ok: false; error: string }
