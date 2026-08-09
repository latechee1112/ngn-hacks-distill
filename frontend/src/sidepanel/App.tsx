import { useEffect, useState } from 'react'
import ToggleSwitch from './ToggleSwitch'
import Icon from './Icon'
import type { SimplifyResponse, VisualProfile } from '../types/analysis'
import { CALIBRATION_STORAGE_KEY, type StoredCalibration } from '../types/calibration'
import { loadStoredCalibration, resolveProfile, type ResolvedProfile } from '../shared/profile'

async function getActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id ?? null
}

// Tabs that were already open when the extension was installed or reloaded
// never got the manifest's content script, so messaging them fails with
// "Receiving end does not exist". Inject it once, on demand, and retry - the
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
// same border - the two overlapped only along the top edge, so it read as visibly
// thicker there than the other three sides. Left out for that reason.) GLASS carries
// the shared mechanics; each variant below only supplies the tint and its hover state.
const GLASS = 'backdrop-blur-md backdrop-saturate-150 border transition-colors'
const GLASS_SECONDARY = `${GLASS} border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/15`
const GLASS_ACCENT = `${GLASS} border-accent-text/30 bg-accent/55 hover:bg-accent/70`

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

// 1.15 -> "1.15x", 1 -> "1x". toFixed alone leaves a trailing zero ("1.10x"),
// which reads as more precision than the rules behind it actually carry.
function scaleLabel(value: number): string {
  return `${Number(value.toFixed(2))}x`
}

// The card's second line, built from the profile actually in force. Every part
// is read off the profile - there is nothing hardcoded here, which is the whole
// point: this line used to be a fixed string that said the same thing for a
// calibrated user, an uncalibrated one, and everyone in between.
function describeProfile(profile: VisualProfile): string {
  const parts = [
    `Spacing +${Math.round((profile.spacingMultiplier - 1) * 100)}%`,
    `Text ${scaleLabel(profile.textScale)}`,
    profile.contrastMode === 'enhanced' ? 'Enhanced contrast' : 'Standard contrast',
    `Up to ${profile.maxVisibleBlocks} blocks`,
  ]
  if (profile.reduceMotion) parts.push('Reduced motion')
  if (profile.progressiveReveal) parts.push('Section by section')
  return parts.join(' · ')
}

// Names the profile honestly rather than implying calibration that never
// happened. A passively-derived profile is real personalization and says so; a
// default one admits it is a default.
function profileHeading(resolved: ResolvedProfile): string {
  if (resolved.origin === 'calibration') {
    return resolved.userName ? `Calibrated to ${resolved.userName}` : 'Your calibrated profile'
  }
  if (resolved.origin === 'usage') return 'Learned from your browsing'
  return 'Default profile'
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

  const [intensity, setIntensity] = useState(DEFAULT_SETTINGS.intensity)
  const [reduceMotion, setReduceMotion] = useState(DEFAULT_SETTINGS.reduceMotion)
  const [largerText, setLargerText] = useState(DEFAULT_SETTINGS.largerText)
  // Guards the persist effect below: without it the first render would write
  // the defaults over whatever was stored before load() resolves.
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  // The profile actually in force, resolved by the same shared helper the
  // content script uses - so this card and the simplification it describes can
  // never disagree about which profile won. null only until the first load
  // resolves, which is why the card renders nothing rather than a placeholder.
  const [resolvedProfile, setResolvedProfile] = useState<ResolvedProfile | null>(null)

  // Shown until the user either finishes or explicitly dismisses the
  // calibration wizard (src/calibration/App.tsx) - starts hidden so it
  // doesn't flash on before the storage check below resolves.
  const [showCalibrationBanner, setShowCalibrationBanner] = useState(false)
  async function checkCalibrationStatus() {
    const record = await loadStoredCalibration()
    setShowCalibrationBanner(!record?.profile && !record?.dismissed)
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
      // Best-effort - worst case the banner reappears next open.
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
      // Only trust the page for these live preferences while it is actually simplified -
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
      // Last, and not awaited alongside the others: the usage tier reads a
      // second storage key and derives from it, so it is the slowest of the
      // three lookups and the card is the least urgent thing on screen.
      setResolvedProfile(await resolveProfile())
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

  // Reduce motion and Larger text are CSS switches, so they apply to an
  // already-simplified page immediately. When nothing is simplified yet the
  // content script reports applied:false and we just keep the preference -
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

  // Blur is a CSS variable on the page, so a drag repaints immediately - no
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
        setError('Not enough sections to paginate, so showing the full article.')
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
            className={`relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-md px-4 py-2 text-body font-medium ${FOCUS_RING} ${analyzing ? `cursor-wait ${GLASS_SECONDARY} text-on-surface-variant` : `${GLASS_ACCENT} text-accent-fg`
              } ${!analyzing && !simplified ? 'simplify-shimmer' : ''}`}
          >
            {/* z-10 so the sweep (the button's own ::after) passes behind the
                label instead of over it. */}
            <span className="relative z-10 flex items-center gap-2">
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
            </span>
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

        {/* Every value here is read off the profile that will actually be used
            (resolveProfile(), shared with the content script). Rendered only
            once resolved - a card that guesses while loading would flash the
            wrong profile name, which is the exact failure this replaced. */}
        {resolvedProfile && (
          <div className="rounded-md border border-outline bg-surface p-4">
            <div className="mb-2 flex items-center gap-2">
              <Icon name="user" className="text-on-surface-variant" />
              <h3 className="text-body font-medium text-on-surface">{profileHeading(resolvedProfile)}</h3>
            </div>
            <p className="text-meta text-on-surface-variant">{describeProfile(resolvedProfile.profile)}</p>
            {/* The rule that fired, in the backend's own words. One line: the
                card is a summary, and the full list lives on the wizard's
                results screen. */}
            {resolvedProfile.explanation.length > 0 && (
              <p className="mt-2 text-meta text-on-surface-muted">{resolvedProfile.explanation[0]}</p>
            )}
            {resolvedProfile.origin === 'default' && (
              <p className="mt-2 text-meta text-on-surface-muted">
                Calibrate, or just keep browsing. Distill builds a profile from how you read.
              </p>
            )}
          </div>
        )}

        <div>
          <h2 className="mb-2 text-meta font-semibold tracking-[0.08em] text-on-surface-variant uppercase">
            Simplification Controls
          </h2>
          {/* Every control here repaints the live page - there is nothing to
              repaint before Simplify Current Page has run, so the whole group
              is inert until then rather than quietly storing preferences a
              user reasonably expects to see take effect immediately. */}
          <div
            className={`overflow-hidden rounded-md border border-outline bg-surface ${
              simplified ? '' : 'opacity-50'
            }`}
          >
            <div className="border-b border-outline p-4">
              <div className="mb-3 flex items-center justify-between">
                <label
                  htmlFor="distill-blur-intensity"
                  className={`text-body font-medium text-on-surface ${simplified ? '' : 'cursor-not-allowed'}`}
                >
                  Blur intensity
                </label>
                <span className="text-meta tabular-nums text-on-surface-variant">{intensity}%</span>
              </div>
              {/* Applies live on drag - it drives a CSS variable on the page, so
                  there is nothing to re-run and nothing to warn about. */}
              <input
                id="distill-blur-intensity"
                type="range"
                min={1}
                max={100}
                value={intensity}
                disabled={!simplified}
                onChange={(e) => changeBlurIntensity(Number(e.target.value))}
                className="disabled:cursor-not-allowed"
              />
            </div>

            <div className="flex flex-col">
              <label
                className={`flex items-center justify-between border-b border-outline px-4 py-3 transition-colors focus-within:ring-2 focus-within:ring-on-surface-variant focus-within:ring-inset ${
                  simplified ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon name="pulse" className="text-on-surface-variant" />
                  <span className="text-body text-on-surface">Reduce motion</span>
                </div>
                <ToggleSwitch checked={reduceMotion} disabled={!simplified} onChange={toggleReduceMotion} />
              </label>
              <label
                className={`flex items-center justify-between border-b border-outline px-4 py-3 transition-colors focus-within:ring-2 focus-within:ring-on-surface-variant focus-within:ring-inset ${
                  simplified ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon name="textSize" className="text-on-surface-variant" />
                  <span className="text-body text-on-surface">Larger text</span>
                </div>
                <ToggleSwitch checked={largerText} disabled={!simplified} onChange={toggleLargerText} />
              </label>
              <label
                className={`flex items-center justify-between border-b border-outline px-4 py-3 transition-colors focus-within:ring-2 focus-within:ring-on-surface-variant focus-within:ring-inset ${
                  simplified && progressiveRevealAvailable ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon name="eye" className="text-on-surface-variant" />
                  <span className="text-body text-on-surface">Progressive reveal</span>
                </div>
                <ToggleSwitch
                  checked={progressiveRevealActive}
                  disabled={!simplified || !progressiveRevealAvailable}
                  onChange={toggleProgressiveReveal}
                />
              </label>
              <label
                className={`flex items-center justify-between px-4 py-3 transition-colors focus-within:ring-2 focus-within:ring-on-surface-variant focus-within:ring-inset ${
                  simplified ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon name="droplet" className="text-on-surface-variant" />
                  <span className="text-body text-on-surface">Reduce color variation</span>
                </div>
                <ToggleSwitch checked={colorReductionActive} disabled={!simplified} onChange={toggleColorReduction} />
              </label>
            </div>
          </div>
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
