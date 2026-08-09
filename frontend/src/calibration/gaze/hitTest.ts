import type { GazeResult } from 'webeyetrack'
import { TARGET_SELECTOR } from '../TrialTask'
import { DECOY_AD_ID, DECOY_SIDEBAR_ID } from './Decoys'

export interface PageGazePoint {
  // Wall-clock (performance.now()) at the moment this sample's callback
  // fired. NOT GazeResult.timestamp, which is relative to video start and
  // on a different clock than the trial start/end markers this gets
  // compared against.
  capturedAt: number
  x: number
  y: number
}

// A blink or lost face reports gazeState:'closed' with normPog:[0,0], which
// maps to viewport CENTER, directly on top of the (centered) trial grid.
// Left unfiltered, every blink would masquerade as a gaze hit on the target.
export function toPagePoint(result: GazeResult, capturedAt: number): PageGazePoint | null {
  if (result.gazeState !== 'open') return null
  const [nx, ny] = result.normPog
  return {
    capturedAt,
    x: (nx + 0.5) * window.innerWidth,
    y: (ny + 0.5) * window.innerHeight,
  }
}

// Gaze error is roughly 85-90px (~2.3cm), still well above the 64px target
// shapes, so per-shape hit-testing remains below the noise floor. Only the
// two (much larger) decoys are actually measurable gaze targets.
const HIT_TOLERANCE_PX = 60

function inflatedRectContains(rect: DOMRect, x: number, y: number): boolean {
  return (
    x >= rect.left - HIT_TOLERANCE_PX &&
    x <= rect.right + HIT_TOLERANCE_PX &&
    y >= rect.top - HIT_TOLERANCE_PX &&
    y <= rect.bottom + HIT_TOLERANCE_PX
  )
}

export function isOnDecoy(point: PageGazePoint): boolean {
  return [DECOY_SIDEBAR_ID, DECOY_AD_ID].some((id) => {
    const el = document.getElementById(id)
    return !!el && inflatedRectContains(el.getBoundingClientRect(), point.x, point.y)
  })
}

export function isOnTarget(point: PageGazePoint, targetRect: DOMRect | null): boolean {
  return !!targetRect && inflatedRectContains(targetRect, point.x, point.y)
}

export function currentTargetRect(): DOMRect | null {
  return document.querySelector(TARGET_SELECTOR)?.getBoundingClientRect() ?? null
}
