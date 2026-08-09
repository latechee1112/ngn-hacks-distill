import type { GazeSummary } from '../../types/calibration'
import { currentTargetRect, isOnDecoy, isOnTarget, type PageGazePoint } from './hitTest'

export interface TrialGazeStats {
  dispersion: number | null
  targetAcquisitionMs: number | null
  distractorRatio: number | null
  sampleCount: number
}

const EMPTY_STATS: TrialGazeStats = {
  dispersion: null,
  targetAcquisitionMs: null,
  distractorRatio: null,
  sampleCount: 0,
}

// WebEyeTrack's internal KalmanFilter2D is never reset between trials, so a
// trial's first samples are still smoothed toward the previous trial's gaze
// position. Drop them rather than let stale carryover skew dispersion/
// acquisition time.
const SETTLE_MS = 300

// samples must already be filtered to this trial's [start, end) window.
export function computeTrialGazeStats(samples: PageGazePoint[], trialStart: number): TrialGazeStats {
  const settled = samples.filter((s) => s.capturedAt - trialStart >= SETTLE_MS)
  if (settled.length === 0) return EMPTY_STATS

  const meanX = settled.reduce((sum, s) => sum + s.x, 0) / settled.length
  const meanY = settled.reduce((sum, s) => sum + s.y, 0) / settled.length
  const dispersion =
    settled.reduce((sum, s) => sum + Math.hypot(s.x - meanX, s.y - meanY) ** 2, 0) / settled.length

  const targetRect = currentTargetRect()
  const firstOnTarget = settled.find((s) => isOnTarget(s, targetRect))
  const targetAcquisitionMs = firstOnTarget ? firstOnTarget.capturedAt - trialStart : null

  const decoyHits = settled.filter(isOnDecoy).length
  const distractorRatio = decoyHits / settled.length

  return { dispersion, targetAcquisitionMs, distractorRatio, sampleCount: settled.length }
}

function average(values: number[]): number | undefined {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined
}

export function combineGazeStats(perTrial: TrialGazeStats[]): GazeSummary {
  const totalSamples = perTrial.reduce((sum, t) => sum + t.sampleCount, 0)
  const withData = perTrial.filter((t) => t.sampleCount > 0)
  if (withData.length === 0) return { enabled: false, sampleCount: 0 }

  return {
    enabled: true,
    sampleCount: totalSamples,
    averageDispersion: average(withData.map((t) => t.dispersion).filter((v): v is number => v !== null)),
    averageTargetAcquisitionMs: average(
      withData.map((t) => t.targetAcquisitionMs).filter((v): v is number => v !== null),
    ),
    distractorGazeRatio: average(withData.map((t) => t.distractorRatio).filter((v): v is number => v !== null)),
  }
}
