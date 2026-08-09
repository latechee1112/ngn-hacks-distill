// Save/load a finished calibration as a portable JSON file.
//
// Primarily a development affordance: re-running the full wizard (camera
// permission, 9 gaze dots, practice, 5 timed trials) just to get a profile
// into chrome.storage is a slow loop to sit through on every reload. Saving
// one run and replaying it makes that instant. It doubles as a real user
// feature, moving a profile to another browser or machine without redoing
// the tasks, which is why the file is versioned rather than an ad-hoc dump.
//
// Everything here treats file contents as UNTRUSTED. A calibration file is
// just a .json the user picked off disk; it could be hand-edited, truncated,
// or an unrelated file entirely, and it ends up in chrome.storage where the
// content script reads it on every page. So the parse below validates every
// field it promises rather than casting, and a bad file is reported instead
// of written.

import type { VisualProfile } from '../types/analysis'

export const CALIBRATION_FILE_KIND = 'distill-calibration'
export const CALIBRATION_FILE_VERSION = 1

export interface CalibrationFile {
  kind: typeof CALIBRATION_FILE_KIND
  version: number
  savedAt: number
  profile: VisualProfile
  explanation: string[]
}

export type ParseResult = { ok: true; file: CalibrationFile } | { ok: false; error: string }

const CONTRAST_MODES = ['standard', 'enhanced'] as const
const SOURCES = ['calibration', 'manual', 'default'] as const
const REGIONS = ['left', 'right', 'center', 'top'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Rejects NaN and +/-Infinity too. JSON.parse cannot produce them, but a
// finite check keeps a hand-edited `1e999` (which parses to Infinity) from
// reaching the layout maths in the content script.
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function oneOf<T extends readonly string[]>(v: unknown, allowed: T): v is T[number] {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
}

function validateProfile(v: unknown): { ok: true; profile: VisualProfile } | { ok: false; error: string } {
  if (!isRecord(v)) return { ok: false, error: 'the "profile" field is missing or is not an object' }

  const missing: string[] = []
  if (typeof v.profileId !== 'string' || v.profileId === '') missing.push('profileId')
  if (!isFiniteNumber(v.maxVisibleBlocks)) missing.push('maxVisibleBlocks')
  if (!isFiniteNumber(v.spacingMultiplier)) missing.push('spacingMultiplier')
  if (!isFiniteNumber(v.textScale)) missing.push('textScale')
  if (!isFiniteNumber(v.simplificationStrength)) missing.push('simplificationStrength')
  if (typeof v.reduceMotion !== 'boolean') missing.push('reduceMotion')
  if (typeof v.progressiveReveal !== 'boolean') missing.push('progressiveReveal')
  if (!oneOf(v.contrastMode, CONTRAST_MODES)) missing.push('contrastMode')
  if (!oneOf(v.source, SOURCES)) missing.push('source')
  // Genuinely optional in VisualProfile: absent is valid, wrong is not.
  if (v.preferredRegion !== undefined && v.preferredRegion !== null && !oneOf(v.preferredRegion, REGIONS)) {
    missing.push('preferredRegion')
  }

  if (missing.length > 0) {
    return { ok: false, error: `profile has missing or invalid fields: ${missing.join(', ')}` }
  }

  // Rebuilt field by field rather than passed through, so nothing extra that
  // happened to be in the file rides along into chrome.storage.
  const profile: VisualProfile = {
    profileId: v.profileId as string,
    maxVisibleBlocks: v.maxVisibleBlocks as number,
    spacingMultiplier: v.spacingMultiplier as number,
    textScale: v.textScale as number,
    contrastMode: v.contrastMode as VisualProfile['contrastMode'],
    reduceMotion: v.reduceMotion as boolean,
    progressiveReveal: v.progressiveReveal as boolean,
    simplificationStrength: v.simplificationStrength as number,
    source: v.source as VisualProfile['source'],
  }
  if (oneOf(v.preferredRegion, REGIONS)) profile.preferredRegion = v.preferredRegion

  return { ok: true, profile }
}

export function parseCalibrationFile(raw: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: "that file isn't valid JSON" }
  }

  if (!isRecord(parsed)) return { ok: false, error: 'that file does not contain a calibration object' }
  if (parsed.kind !== CALIBRATION_FILE_KIND) {
    return { ok: false, error: "that doesn't look like a Distill calibration file" }
  }
  // Forward-compatibility guard: a newer file could carry fields this build
  // does not understand, and silently loading the parts it recognises would
  // apply a profile that isn't the one that was saved.
  if (!isFiniteNumber(parsed.version) || parsed.version > CALIBRATION_FILE_VERSION) {
    return {
      ok: false,
      error: `that file was saved by a newer version of Distill (file v${String(parsed.version)}, this build reads v${CALIBRATION_FILE_VERSION})`,
    }
  }

  const profileResult = validateProfile(parsed.profile)
  if (!profileResult.ok) return { ok: false, error: profileResult.error }

  const explanation = Array.isArray(parsed.explanation)
    ? parsed.explanation.filter((line): line is string => typeof line === 'string')
    : []

  return {
    ok: true,
    file: {
      kind: CALIBRATION_FILE_KIND,
      version: parsed.version,
      savedAt: isFiniteNumber(parsed.savedAt) ? parsed.savedAt : Date.now(),
      profile: profileResult.profile,
      explanation,
    },
  }
}

export function buildCalibrationFile(profile: VisualProfile, explanation: string[]): CalibrationFile {
  return {
    kind: CALIBRATION_FILE_KIND,
    version: CALIBRATION_FILE_VERSION,
    savedAt: Date.now(),
    profile,
    explanation,
  }
}

export function calibrationFileName(file: CalibrationFile): string {
  const date = new Date(file.savedAt)
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
  return `distill-calibration-${stamp}.json`
}

// Blob + object URL rather than a data: URI, because an extension page's CSP blocks
// navigation to data: URLs, and a blob: URL of the page's own origin is not
// subject to that. Revoked on the next task, once the click has been handled.
export function downloadCalibrationFile(file: CalibrationFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = calibrationFileName(file)
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
