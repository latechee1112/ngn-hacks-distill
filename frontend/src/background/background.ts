import { ANALYZE_PORT } from '../shared/messaging'
import type { AnalyzeBackendResult } from '../types/analysis'

// Local dev backend. The fetch must happen here in the service worker, not in the
// content script - a content script's fetch Origin is the visited page's origin, not
// chrome-extension://<id>, so it wouldn't match the backend's CORS allowlist.
const BACKEND_URL = 'http://127.0.0.1:8000'
// Generous headroom over the backend's own LLM timeout (45s) plus network overhead -
// real pages send far more blocks than a quick manual test (a 100+ block Wikipedia
// page takes much longer for the LLM to classify than a tiny 4-block payload).
const ANALYZE_TIMEOUT_MS = 60000

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Distill] service worker installed')
  // First install only - walks the user through the calibration wizard in a
  // full tab (a popup is capped at ~600x800px, nowhere near "full screen").
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('calibration.html') }).catch(console.error)
  }
})

async function analyzePage(payload: unknown): Promise<AnalyzeBackendResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS)

  try {
    const response = await fetch(`${BACKEND_URL}/v1/analyze-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, error: `Backend returned ${response.status}: ${detail}` }
    }

    return { ok: true, data: await response.json() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeout)
  }
}

// Analysis runs over a long-lived port rather than one-shot sendMessage, for two
// reasons that are really the same reason - an MV3 service worker is disposable:
//
//   1. Liveness. If the worker is torn down mid-analysis, a sendMessage callback can
//      simply never fire, leaving the content script waiting forever on a reply that
//      isn't coming (and its scan animation sweeping over a page nothing is analyzing).
//      A port's onDisconnect fires the instant the worker goes, so the caller finds out
//      immediately instead of waiting out a timeout.
//   2. Survival. Traffic over a port resets the worker's idle timer, so the heartbeat
//      below also keeps the worker alive for the length of a slow analysis - which
//      means the disconnect it's there to detect mostly stops happening.
// Comfortably under the ~30s idle shutdown, and frequent enough that the content
// script's watchdog can call a stall quickly without being trigger-happy.
const HEARTBEAT_MS = 5000

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ANALYZE_PORT) return

  let closed = false
  const close = () => {
    closed = true
    clearInterval(heartbeat)
  }

  const heartbeat = setInterval(() => {
    if (closed) return
    // The port can drop between the interval firing and this line (tab closed,
    // navigation); postMessage on a dead port throws.
    try {
      port.postMessage({ type: 'heartbeat' })
    } catch {
      close()
    }
  }, HEARTBEAT_MS)

  // The content script went away - nothing to answer, so stop the heartbeat rather
  // than leaving an interval running in the worker.
  port.onDisconnect.addListener(close)

  port.onMessage.addListener((message) => {
    if (message?.type !== 'analyze') return
    analyzePage(message.payload).then((result) => {
      if (closed) return
      try {
        port.postMessage({ type: 'result', result })
      } catch {
        // Caller is gone; the result has nowhere to go.
      }
      close()
      port.disconnect()
    })
  })
})
