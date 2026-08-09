import { useEffect, useState } from 'react'
import ToggleSwitch from './ToggleSwitch'
import Icon from './Icon'
import type { ExtractionResult } from '../types/page'
import type { SimplifyResponse } from '../types/analysis'
import { CALIBRATION_STORAGE_KEY, type StoredCalibration } from '../types/calibration'

async function getActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id ?? null
}

// Tabs that were already open when the extension was installed or reloaded
// never got the manifest's content script, so messaging them fails with
// "Receiving end does not exist". Inject it once, on demand, and retry — the
// injection only happens after a failed ping, so a tab that already has the
// script never gets a second copy (and a second message listener).
async function sendToTab<T>(tabId: number, message: unknown): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T
  } catch (err) {
    if (!String(err).includes('Receiving end does not exist')) throw err
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    return (await chrome.tabs.sendMessage(tabId, message)) as T
  }
}

const EXTENSION_VERSION = chrome.runtime.getManifest().version

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-surface-variant focus-visible:ring-offset-2 focus-visible:ring-offset-background'

// One restrained glass language, reused by every button in the panel instead of each
// picking its own surface treatment: translucent fill + backdrop blur + a hairline
// border, uniform on all four sides. No gradients, no glow, no per-button variation
// beyond the tint. (An earlier version added an inset top highlight on top of this
// same border — the two overlapped only along the top edge, so it read as visibly
// thicker there than the other three sides. Left out for that reason.) GLASS carries
// the shared mechanics; each variant below only supplies the tint and its hover state.
const GLASS = 'backdrop-blur-md backdrop-saturate-150 border transition-colors'
const GLASS_SECONDARY = `${GLASS} border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/15`
const GLASS_ACCENT = `${GLASS} border-accent-text/30 bg-accent/55 hover:bg-accent/70`
const GLASS_DEBUG = `${GLASS} border-debug-text/30 bg-debug/15 hover:bg-debug/25`
// No fill at rest — the glass only condenses in on hover/focus, for the one button
// that's meant to read as the lowest-emphasis action in the panel.
const GLASS_GHOST =
  'border border-transparent transition-colors hover:border-white/10 hover:bg-white/6 hover:backdrop-blur-md hover:backdrop-saturate-150'

// The panel unmounts every time it closes, so the Simplification Controls have
// to persist somewhere. chrome.storage.local (the "storage" permission is
// already in the manifest) keeps them across opens and across browser restarts.
const SETTINGS_KEY = 'distillSettings'

interface StoredSettings {
  intensity: number // 1-100, as shown on the slider
  reduceMotion: boolean
  largerText: boolean
  reduceColorVariation: boolean
}

const DEFAULT_SETTINGS: StoredSettings = {
  // 75% - deemphasized content should read as strongly blurred/censored the
  // first time a page is simplified, before the user touches the slider.
  intensity: 75,
  // Off by default - a real OS-level "prefers-reduced-motion" preference
  // still suppresses motion independently (see scanAnimation.ts's
  // prefersReducedMotion()), so this only controls Distill's own opinion,
  // not actual accessibility. Defaulting it on suppressed the scan-sweep
  // animation for every user who never touched this toggle.
  reduceMotion: false,
  largerText: true,
  reduceColorVariation: false,
}

async function loadSettings(): Promise<StoredSettings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY)
    return { ...DEFAULT_SETTINGS, ...(stored?.[SETTINGS_KEY] ?? {}) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function App() {
  const [simplified, setSimplified] = useState(false)
  const [colorReductionActive, setColorReductionActive] = useState(false)
  const [progressiveRevealAvailable, setProgressiveRevealAvailable] = useState(false)
  const [progressiveRevealActive, setProgressiveRevealActive] = useState(false)
  const [error, setError] = useState<string>('')
  const [analyzing, setAnalyzing] = useState(false)
  // Ads/sponsored units the local pre-filter removed on this page. 0 is a real
  // answer ("clean page"), so this only renders once something is simplified.
  const [adsHidden, setAdsHidden] = useState(0)

  // Debug-only: the last raw extraction, pretty-printed. null means "never
  // dumped in this panel session" — the output panel stays hidden until then.
  const [rawBlocks, setRawBlocks] = useState<string | null>(null)
  const [rawBlockCount, setRawBlockCount] = useState(0)
  const [dumping, setDumping] = useState(false)
  const [copied, setCopied] = useState(false)

  const [intensity, setIntensity] = useState(DEFAULT_SETTINGS.intensity)
  const [reduceMotion, setReduceMotion] = useState(DEFAULT_SETTINGS.reduceMotion)
  const [largerText, setLargerText] = useState(DEFAULT_SETTINGS.largerText)
  // Guards the persist effect below: without it the first render would write
  // the defaults over whatever was stored before load() resolves.
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  // Shown until the user either finishes or explicitly dismisses the
  // calibration wizard (src/calibration/App.tsx) — starts hidden so it
  // doesn't flash on before the storage check below resolves.
  const [showCalibrationBanner, setShowCalibrationBanner] = useState(false)
  async function checkCalibrationStatus() {
    try {
      const stored = await chrome.storage.local.get(CALIBRATION_STORAGE_KEY)
      const record = stored?.[CALIBRATION_STORAGE_KEY] as StoredCalibration | undefined
      setShowCalibrationBanner(!record?.profile && !record?.dismissed)
    } catch {
      setShowCalibrationBanner(false)
    }
  }

  function openCalibration() {
    chrome.tabs.create({ url: chrome.runtime.getURL('calibration.html') }).catch(() => { })
  }

  async function dismissCalibrationBanner() {
    setShowCalibrationBanner(false)
    try {
      const record: StoredCalibration = { dismissed: true }
      await chrome.storage.local.set({ [CALIBRATION_STORAGE_KEY]: record })
    } catch {
      // Best-effort — worst case the banner reappears next open.
    }
  }

  async function refreshStatus() {
    try {
      const tabId = await getActiveTabId()
      if (!tabId) return
      const response = (await sendToTab(tabId, { type: 'DISTILL_STATUS' })) as {
        simplified: boolean
        colorReductionActive: boolean
        progressiveRevealAvailable: boolean
        progressiveRevealActive: boolean
        reduceMotionActive: boolean
        largerTextActive: boolean
        adsHidden: number
        blurIntensity: number
      }
      setSimplified(response.simplified)
      setAdsHidden(response.adsHidden ?? 0)
      setProgressiveRevealAvailable(response.progressiveRevealAvailable)
      setProgressiveRevealActive(response.progressiveRevealActive)
      // Only trust the page for these live preferences while it is actually simplified —
      // an unsimplified page has both cleared, which says nothing about what
      // the user prefers next time.
      if (response.simplified) {
        setReduceMotion(response.reduceMotionActive)
        setLargerText(response.largerTextActive)
        setColorReductionActive(response.colorReductionActive)
        // The live page is the source of truth for blur while it is simplified,
        // so reopening the panel shows the blur actually on screen.
        if (Number.isFinite(response.blurIntensity)) {
          setIntensity(Math.round(response.blurIntensity * 100))
        }
      }
    } catch {
      setSimplified(false)
      setProgressiveRevealAvailable(false)
      setProgressiveRevealActive(false)
    }
  }

  useEffect(() => {
    // Sequential on purpose: stored preferences load first, then refreshStatus
    // may override the live toggles from the actual page state.
    async function init() {
      const stored = await loadSettings()
      setIntensity(stored.intensity)
      setReduceMotion(stored.reduceMotion)
      setLargerText(stored.largerText)
      setColorReductionActive(stored.reduceColorVariation)
      await refreshStatus()
      await checkCalibrationStatus()
      setSettingsLoaded(true)
    }
    init()
  }, [])

  useEffect(() => {
    if (!settingsLoaded) return
    chrome.storage.local
      .set({ [SETTINGS_KEY]: { intensity, reduceMotion, largerText, reduceColorVariation: colorReductionActive } })
      .catch(() => { })
  }, [settingsLoaded, intensity, reduceMotion, largerText, colorReductionActive])

  async function simplifyPage() {
    setError('')
    setAnalyzing(true)
    try {
      const tabId = await getActiveTabId()
      if (!tabId) {
        setError('No active tab found')
        return
      }
      const response = await sendToTab<SimplifyResponse>(tabId, {
        type: 'DISTILL_SIMPLIFY',
        settings: {
          // Slider is 1-100; the backend's VisualProfile wants 0.0-1.0.
          simplificationStrength: intensity / 100,
          reduceMotion,
          largerText,
          reduceColorVariation: colorReductionActive,
        },
      })
      // The content script rolls the page back before reporting a failure, so the
      // panel stays on "not simplified" rather than offering a restore for a page
      // that was never transformed.
      if (!response.ok) {
        setError(`Couldn't simplify this page: ${response.error}`)
        return
      }
      setSimplified(true)
      setAdsHidden(response.adsHidden ?? 0)
      setProgressiveRevealAvailable(response.primaryFound)
    } catch (err) {
      setError(`Couldn't simplify this page: ${String(err)}`)
    } finally {
      setAnalyzing(false)
    }
  }

  async function restorePage() {
    setError('')
    try {
      const tabId = await getActiveTabId()
      if (!tabId) {
        setError('No active tab found')
        return
      }
      await sendToTab(tabId, { type: 'DISTILL_RESTORE' })
      setSimplified(false)
      setProgressiveRevealAvailable(false)
      setProgressiveRevealActive(false)
      setAdsHidden(0)
    } catch (err) {
      setError(`Couldn't restore this page: ${String(err)}`)
    }
  }

  // Debug affordance: re-runs the same extraction that gets sent to the backend
  // and shows it verbatim, so a bad simplification can be traced to what the
  // page actually looked like at extraction time. Read-only — DISTILL_EXTRACT
  // touches nothing but the data-distill-id attributes extract() already sets.
  async function dumpRawBlocks() {
    setError('')
    setCopied(false)
    setDumping(true)
    try {
      const tabId = await getActiveTabId()
      if (!tabId) {
        setError('No active tab found')
        return
      }
      const response = await sendToTab<ExtractionResult>(tabId, { type: 'DISTILL_EXTRACT' })
      setRawBlockCount(response.blocks.length)
      setRawBlocks(JSON.stringify(response.blocks, null, 2))
    } catch (err) {
      setRawBlocks(null)
      setRawBlockCount(0)
      // Chrome refuses injection on its own pages and the Web Store, so this
      // is a page Distill can never read — not a bug worth a raw stack trace.
      const message = /cannot be scripted|chrome:\/\/|extension:\/\//i.test(String(err))
        ? "This page can't be read by extensions (chrome:// pages, the Web Store, and PDF viewer are off limits)."
        : String(err)
      setError(`Couldn't extract blocks from this page: ${message}`)
    } finally {
      setDumping(false)
    }
  }

  async function copyRawBlocks() {
    if (!rawBlocks) return
    try {
      await navigator.clipboard.writeText(rawBlocks)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      setError(`Couldn't copy to clipboard: ${String(err)}`)
    }
  }

  // Reduce motion and Larger text are CSS switches, so they apply to an
  // already-simplified page immediately. When nothing is simplified yet the
  // content script reports applied:false and we just keep the preference —
  // it ships with the next Activate.
  async function pushLayoutPreference(
    type: 'DISTILL_SET_REDUCE_MOTION' | 'DISTILL_SET_LARGER_TEXT',
    enabled: boolean,
  ) {
    setError('')
    try {
      const tabId = await getActiveTabId()
      if (!tabId) return
      await sendToTab(tabId, { type, enabled })
    } catch {
      // No content script on this tab (chrome:// page, PDF viewer, etc.).
      // The preference is still stored and still applies on the next page.
    }
  }

  function toggleReduceMotion(enabled: boolean) {
    setReduceMotion(enabled)
    pushLayoutPreference('DISTILL_SET_REDUCE_MOTION', enabled)
  }

  function toggleLargerText(enabled: boolean) {
    setLargerText(enabled)
    pushLayoutPreference('DISTILL_SET_LARGER_TEXT', enabled)
  }

  // Blur is a CSS variable on the page, so a drag repaints immediately — no
  // re-analysis, nothing to wait for. Fired on every change event; each message
  // is a single custom-property write, which is cheap enough to keep up with
  // the slider.
  async function changeBlurIntensity(next: number) {
    setIntensity(next)
    try {
      const tabId = await getActiveTabId()
      if (!tabId) return
      await sendToTab(tabId, { type: 'DISTILL_SET_BLUR', intensity: next / 100 })
    } catch {
      // No content script on this tab. The value is still stored and still
      // applies the next time a page is simplified.
    }
  }

  async function toggleColorReduction(enabled: boolean) {
    setError('')
    setColorReductionActive(enabled)
    try {
      const tabId = await getActiveTabId()
      if (!tabId) {
        setError('No active tab found')
        return
      }
      const response = (await sendToTab(tabId, {
        type: 'DISTILL_SET_COLOR_REDUCTION',
        enabled,
      })) as { applied: boolean; active: boolean }
      // An unsimplified page reports applied:false; keep the saved preference
      // so it is applied by the next Simplify Current Page action.
      if (response.applied) setColorReductionActive(response.active)
    } catch (err) {
      // Restricted tabs cannot host the content script. The preference is still
      // saved and will apply on the next page that can be simplified.
      if (!/cannot be scripted|chrome:\/\/|extension:\/\//i.test(String(err))) {
        setError(`Couldn't apply color reduction to this page: ${String(err)}`)
      }
    }
  }

  async function toggleProgressiveReveal(enabled: boolean) {
    setError('')
    try {
      const tabId = await getActiveTabId()
      if (!tabId) {
        setError('No active tab found')
        return
      }
      const response = (await sendToTab(tabId, {
        type: 'DISTILL_SET_PROGRESSIVE_REVEAL',
        enabled,
      })) as { applied: boolean; active: boolean }
      setProgressiveRevealActive(response.active)
      if (enabled && !response.applied) {
        setError('Not enough sections to paginate — showing full article.')
      }
    } catch (err) {
      setError(`Couldn't toggle progressive reveal: ${String(err)}`)
    }
  }

  return (
    <div className="relative flex max-h-[600px] w-full flex-col overflow-hidden bg-background">
      <header className="flex w-full shrink-0 items-center justify-between border-b border-outline bg-background px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon name="funnel" className="text-on-background" />
          <h1 className="text-title font-semibold tracking-tight text-on-background">Distill</h1>
        </div>
        <ToggleSwitch checked={true} size="md" />
      </header>

      <main className="flex flex-1 flex-col gap-6 overflow-y-auto bg-background p-4">
        {showCalibrationBanner && (
          <div className="flex items-start gap-3 rounded-md border border-outline bg-surface p-3">
            <Icon name="user" className="mt-0.5 text-accent-text" />
            <div className="flex-1">
              <p className="text-body font-medium text-on-surface">Finish setup for a personalized experience</p>
              <p className="mt-1 text-meta text-on-surface-variant">
                A one-minute calibration tunes Distill to how you scan a page.
              </p>
              <button
                type="button"
                onClick={openCalibration}
                className={`mt-2 text-meta font-medium text-accent-text transition-colors hover:text-accent-hover ${FOCUS_RING}`}
              >
                Finish setup
              </button>
            </div>
            <button
              type="button"
              onClick={dismissCalibrationBanner}
              aria-label="Dismiss"
              className={`text-on-surface-variant transition-colors hover:text-on-surface ${FOCUS_RING}`}
            >
              ×
            </button>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="inline-flex items-center gap-2 rounded-full border border-outline bg-surface px-3 py-1">
            <div className={`h-1.5 w-1.5 rounded-full ${simplified ? 'bg-accent-text' : 'bg-on-surface-muted'}`} />
            <span className={`text-meta font-medium ${simplified ? 'text-accent-text' : 'text-on-surface-variant'}`}>
              {simplified ? 'Local processing active' : 'Local processing idle'}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={simplified ? restorePage : simplifyPage}
            disabled={analyzing}
            aria-busy={analyzing}
            className={`flex w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-body font-medium ${FOCUS_RING} ${analyzing ? `cursor-wait ${GLASS_SECONDARY} text-on-surface-variant` : `${GLASS_ACCENT} text-accent-fg`
              }`}
          >
            {analyzing ? (
              <>
                <Icon name="spinner" className="animate-spin text-accent-text" />
                Simplifying…
              </>
            ) : (
              <>
                <Icon name={simplified ? 'restore' : 'layers'} />
                {simplified ? 'Show Original Page' : 'Simplify Current Page'}
              </>
            )}
          </button>
          <button
            type="button"
            className={`flex w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-body font-medium text-on-surface ${GLASS_SECONDARY} ${FOCUS_RING}`}
          >
            <Icon name="sliders" />
            View Settings
          </button>
          <button
            type="button"
            onClick={openCalibration}
            className={`flex w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-body font-medium text-on-surface ${GLASS_SECONDARY} ${FOCUS_RING}`}
          >
            <Icon name="eye" />
            Recalibrate
          </button>
        </div>

        {error && <p className="text-meta text-danger-text">{error}</p>}

        {simplified && (
          <p className="text-meta text-on-surface-variant">
            {adsHidden > 0
              ? `Filtered ${adsHidden} ad${adsHidden === 1 ? '' : 's'} / sponsored block${adsHidden === 1 ? '' : 's'} locally.`
              : 'No obvious ads or sponsored blocks found on this page.'}
          </p>
        )}

        <div className="rounded-md border border-outline bg-surface p-4">
          <div className="mb-2 flex items-center gap-2">
            <Icon name="user" className="text-on-surface-variant" />
            <h3 className="text-body font-medium text-on-surface">
              Calibrated to Chenyu Lu
            </h3>
          </div>
          <p className="text-meta text-on-surface-variant">
            Spacing: +10% · Text: 1.05x · Monochrome Text
          </p>
        </div>

        <div>
          <h2 className="mb-2 text-meta font-semibold tracking-[0.08em] text-on-surface-variant uppercase">
            Simplification Controls
          </h2>
          <div className="overflow-hidden rounded-md border border-outline bg-surface">
            <div className="border-b border-outline p-4">
              <div className="mb-3 flex items-center justify-between">
                <label htmlFor="distill-blur-intensity" className="text-body font-medium text-on-surface">
                  Blur intensity
                </label>
                <span className="text-meta tabular-nums text-on-surface-variant">{intensity}%</span>
              </div>
              {/* Applies live on drag — it drives a CSS variable on the page, so
                  there is nothing to re-run and nothing to warn about. */}
              <input
                id="distill-blur-intensity"
                type="range"
                min={1}
                max={100}
                value={intensity}
                onChange={(e) => changeBlurIntensity(Number(e.target.value))}
              />
            </div>

            <div className="flex flex-col">
              <label
                className="flex cursor-pointer items-center justify-between border-b border-outline px-4 py-3 transition-colors hover:bg-surface-hover focus-within:ring-2 focus-within:ring-on-surface-variant focus-within:ring-inset"
              >
                <div className="flex items-center gap-3">
                  <Icon name="pulse" className="text-on-surface-variant" />
                  <span className="text-body text-on-surface">Reduce motion</span>
                </div>
                <ToggleSwitch checked={reduceMotion} onChange={toggleReduceMotion} />
              </label>
              <label
                className="flex cursor-pointer items-center justify-between border-b border-outline px-4 py-3 transition-colors hover:bg-surface-hover focus-within:ring-2 focus-within:ring-on-surface-variant focus-within:ring-inset"
              >
                <div className="flex items-center gap-3">
                  <Icon name="textSize" className="text-on-surface-variant" />
                  <span className="text-body text-on-surface">Larger text</span>
                </div>
                <ToggleSwitch checked={largerText} onChange={toggleLargerText} />
              </label>
              <label
                className="flex cursor-pointer items-center justify-between border-b border-outline px-4 py-3 transition-colors hover:bg-surface-hover focus-within:ring-2 focus-within:ring-on-surface-variant focus-within:ring-inset"
              >
                <div className="flex items-center gap-3">
                  <Icon name="eye" className="text-on-surface-variant" />
                  <span className="text-body text-on-surface">Progressive reveal</span>
                </div>
                <ToggleSwitch
                  checked={progressiveRevealActive}
                  disabled={!progressiveRevealAvailable}
                  onChange={toggleProgressiveReveal}
                />
              </label>
              <label
                className="flex cursor-pointer items-center justify-between px-4 py-3 transition-colors hover:bg-surface-hover focus-within:ring-2 focus-within:ring-on-surface-variant focus-within:ring-inset"
              >
                <div className="flex items-center gap-3">
                  <Icon name="droplet" className="text-on-surface-variant" />
                  <span className="text-body text-on-surface">Reduce color variation</span>
                </div>
                <ToggleSwitch
                  checked={colorReductionActive}
                  onChange={toggleColorReduction}
                />
              </label>
            </div>
          </div>
        </div>

        <div>
          <button
            type="button"
            className={`flex w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-body text-on-surface-variant hover:text-on-surface ${GLASS_GHOST} ${FOCUS_RING}`}
          >
            <Icon name="expand" />
            Show everything temporarily
          </button>
        </div>

        {/* Debug tools. Bright green on purpose — this is developer output, not
            a user-facing control, and it should never blend into the panel. */}
        <div className="flex flex-col gap-2 pb-2">
          <h2 className="text-meta font-semibold tracking-[0.08em] text-on-surface-variant uppercase">Debug</h2>
          <button
            type="button"
            onClick={dumpRawBlocks}
            disabled={dumping}
            aria-busy={dumping}
            className={`flex w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-body font-medium ${FOCUS_RING} ${dumping ? `cursor-wait ${GLASS_SECONDARY} text-on-surface-variant` : `${GLASS_DEBUG} text-debug-fg`
              }`}
          >
            {dumping ? (
              <>
                <Icon name="spinner" className="animate-spin text-debug-text" />
                Extracting…
              </>
            ) : (
              <>
                <Icon name="bug" />
                Dump Raw Blocks JSON
              </>
            )}
          </button>

          {rawBlocks !== null && (
            <details className="overflow-hidden rounded-md border border-debug/40 bg-surface" open>
              <summary
                className={`cursor-pointer list-none px-3 py-2 text-meta font-semibold text-debug-text select-none marker:content-none hover:bg-surface-hover ${FOCUS_RING}`}
              >
                Raw blocks JSON · {rawBlockCount} block{rawBlockCount === 1 ? '' : 's'}
              </summary>
              <div className="border-t border-outline">
                <pre className="max-h-64 overflow-auto p-3 font-mono text-meta leading-[15px] whitespace-pre text-on-surface">
                  {rawBlocks}
                </pre>
                <div className="flex justify-end border-t border-outline p-2">
                  <button
                    type="button"
                    onClick={copyRawBlocks}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-meta text-on-surface ${GLASS_SECONDARY} ${FOCUS_RING}`}
                  >
                    <Icon name={copied ? 'check' : 'copy'} className={copied ? 'text-debug-text' : ''} />
                    {copied ? 'Copied' : 'Copy JSON'}
                  </button>
                </div>
              </div>
            </details>
          )}
        </div>

        <footer className="mt-2 flex w-full flex-col items-center gap-2 border-t border-outline pt-4 text-meta text-on-surface-variant">
          <div className="flex items-center gap-3">
            <a className={`rounded-sm transition-colors hover:text-on-background ${FOCUS_RING}`} href="#">
              Privacy
            </a>
            <span className="text-on-surface-muted">·</span>
            <a className={`rounded-sm transition-colors hover:text-on-background ${FOCUS_RING}`} href="#">
              Feedback
            </a>
          </div>
          <p className="text-on-surface-muted">Distill v{EXTENSION_VERSION}</p>
        </footer>
      </main>
    </div>
  )
}

export default App
