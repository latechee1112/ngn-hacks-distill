// Passive visual profile: builds a VisualProfile out of ordinary browsing,
// for users who never run the calibration wizard.
//
// The calibration wizard measures the same three things this does — how much
// clutter costs you, where your attention leaks to, and whether you read or
// skim — just under controlled conditions with synthetic decoys. This is the
// uncontrolled version of the same measurement, so the derivation rules below
// deliberately mirror backend/services/profile_rules.py: a distractor-click
// rate gate, an attention-leak gate, and a skim gate, each with its own
// explanation string. Nothing here is a model; every field is traceable to a
// counter and a threshold.
//
// PRIVACY: only integer counters ever leave this module. No URLs, no element
// text, no per-site breakdown, no timestamps beyond a single updatedAt. What
// is stored cannot identify a page that was visited, only that (say) 31% of
// clicks in aggregate landed on page furniture.

import type { VisualProfile } from '../types/analysis'
import { isAdLike, isSidebarLike, isStickyOrFixed } from './dom-heuristics'

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
  // Clicks that landed on an ad, a rail, a sticky promo or nav — the in-the-wild
  // equivalent of the calibration wizard's decoy sidebar/ad.
  distractorClickCount: number
}

const EMPTY_SIGNALS: UsageSignals = {
  version: USAGE_SIGNALS_VERSION,
  updatedAt: 0,
  dwellMsContent: 0,
  dwellMsPeripheral: 0,
  glanceCount: 0,
  readCount: 0,
  clickCount: 0,
  distractorClickCount: 0,
}

// A region visible this long was read; below GLANCE_MIN_MS it was not really
// seen at all and is ignored rather than counted as a glance (scrolling fast
// through a long page would otherwise manufacture hundreds of "glances").
const READ_MS = 2000
const GLANCE_MIN_MS = 400

// Below this, the ratios are noise and deriveUsageProfile() returns null — the
// caller then falls back to DEFAULT_PROFILE exactly as before. Roughly a few
// minutes of ordinary browsing.
const MIN_INTERACTIONS = 25

// Mirrors profile_rules.py's _DECOY_CLICK_RATE_THRESHOLD in intent: direct
// behavioral evidence, so it is allowed to move maxVisibleBlocks on its own.
const DISTRACTOR_CLICK_RATIO = 0.25
// Attention leaking to furniture. Softer evidence than a click (you can look at
// a rail without it costing you anything), so it only adds strength.
const PERIPHERAL_DWELL_RATIO = 0.35
// Mostly glancing rather than reading — progressive reveal is for this user.
const GLANCE_RATIO = 0.6

const OBSERVED_SELECTOR = 'main, article, section, nav, aside, header, footer'

// isStickyOrFixed() reads getComputedStyle, and closeInterval() calls this from
// inside an IntersectionObserver callback - i.e. during scroll, where a forced
// style read is exactly what you don't want. An element does not change from
// content to furniture, so the answer is cached for the element's lifetime and
// a region scrolled in and out repeatedly pays for it once.
const peripheralCache = new WeakMap<Element, boolean>()

function isPeripheral(el: Element): boolean {
  const cached = peripheralCache.get(el)
  if (cached !== undefined) return cached

  const tag = el.tagName.toLowerCase()
  // Tag first: it settles most furniture without touching layout or style at all.
  const result =
    ['nav', 'aside', 'header', 'footer'].includes(tag) ||
    isAdLike(el) ||
    isSidebarLike(el) ||
    isStickyOrFixed(el)
  peripheralCache.set(el, result)
  return result
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

// Deltas since the last flush, not absolute totals: several tabs track at once,
// so a flush must add to whatever is in storage rather than overwrite it.
let pending: UsageSignals = { ...EMPTY_SIGNALS }
let flushTimer = 0
let started = false

const FLUSH_DEBOUNCE_MS = 5000

function hasPending(): boolean {
  return (
    pending.dwellMsContent > 0 ||
    pending.dwellMsPeripheral > 0 ||
    pending.glanceCount > 0 ||
    pending.readCount > 0 ||
    pending.clickCount > 0
  )
}

async function flush(): Promise<void> {
  if (!hasPending()) return
  const delta = pending
  pending = { ...EMPTY_SIGNALS }
  try {
    const stored = await loadUsageSignals()
    await chrome.storage.local.set({
      [USAGE_STORAGE_KEY]: {
        version: USAGE_SIGNALS_VERSION,
        updatedAt: Date.now(),
        dwellMsContent: stored.dwellMsContent + delta.dwellMsContent,
        dwellMsPeripheral: stored.dwellMsPeripheral + delta.dwellMsPeripheral,
        glanceCount: stored.glanceCount + delta.glanceCount,
        readCount: stored.readCount + delta.readCount,
        clickCount: stored.clickCount + delta.clickCount,
        distractorClickCount: stored.distractorClickCount + delta.distractorClickCount,
      } satisfies UsageSignals,
    })
  } catch {
    // Extension context invalidated, or storage unavailable. The deltas are
    // gone, which costs a few counters — never the page.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = window.setTimeout(() => {
    flushTimer = 0
    void flush()
  }, FLUSH_DEBOUNCE_MS)
}

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
  pending = { ...EMPTY_SIGNALS }
  try {
    await chrome.storage.local.remove(USAGE_STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}

// Regions currently in view, with the timestamp they became visible. Time only
// accrues while the document is actually focused — a tab left open in the
// background is not reading.
const visibleSince = new Map<Element, number>()

function closeInterval(el: Element, now: number): void {
  const since = visibleSince.get(el)
  if (since === undefined) return
  visibleSince.delete(el)
  const elapsed = now - since
  if (elapsed < GLANCE_MIN_MS) return

  if (isPeripheral(el)) pending.dwellMsPeripheral += elapsed
  else pending.dwellMsContent += elapsed

  if (elapsed >= READ_MS) pending.readCount += 1
  else pending.glanceCount += 1
  scheduleFlush()
}

export function startUsageTracking(): void {
  if (started) return
  started = true

  const observer = new IntersectionObserver(
    (entries) => {
      const now = performance.now()
      entries.forEach((entry) => {
        if (entry.isIntersecting && document.hasFocus()) {
          if (!visibleSince.has(entry.target)) visibleSince.set(entry.target, now)
        } else {
          closeInterval(entry.target, now)
        }
      })
    },
    // Half the region on screen, so a footer clipping into view by 2px is not
    // recorded as attention spent on the footer.
    { threshold: 0.5 },
  )

  const observeWithin = (root: ParentNode) => {
    root.querySelectorAll(OBSERVED_SELECTOR).forEach((el) => observer.observe(el))
  }
  observeWithin(document)

  // Feeds and SPAs add regions after load. Same two protections as simplify.ts's
  // ad observer, and for the same reason: a feed mutates continuously while
  // scrolling, so this is debounced on idle rather than run per mutation, and it
  // scans only the subtrees that were actually inserted rather than re-querying
  // the whole document. Only childList is observed, so our own attribute and
  // class changes cannot re-trigger it.
  let rescan = 0
  let pendingRoots: Element[] = []
  const domObserver = new MutationObserver((records) => {
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) pendingRoots.push(node as Element)
      })
    })
    if (!pendingRoots.length || rescan) return
    rescan = window.setTimeout(() => {
      rescan = 0
      const roots = pendingRoots
      pendingRoots = []
      roots.forEach((root) => {
        if (!root.isConnected) return
        if (root.matches(OBSERVED_SELECTOR)) observer.observe(root)
        observeWithin(root)
      })
    }, 1000)
  })
  domObserver.observe(document.body, { childList: true, subtree: true })

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null
      if (!target || typeof target.closest !== 'function') return
      pending.clickCount += 1
      // Walk a bounded number of ancestors rather than the whole chain: a click
      // inside an ad is a distractor click, but every click has <body> as an
      // ancestor and body is not evidence of anything.
      let node: Element | null = target
      for (let depth = 0; node && depth < 6; depth += 1) {
        if (isPeripheral(node)) {
          pending.distractorClickCount += 1
          break
        }
        node = node.parentElement
      }
      scheduleFlush()
    },
    true,
  )

  // Focus/visibility changes end every open interval — otherwise a tab left
  // open overnight records eight hours of "reading".
  const closeAll = () => {
    const now = performance.now()
    Array.from(visibleSince.keys()).forEach((el) => closeInterval(el, now))
  }
  window.addEventListener('blur', closeAll)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) closeAll()
  })
  window.addEventListener('pagehide', () => {
    closeAll()
    void flush()
  })
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export interface UsageProfileResult {
  profile: VisualProfile
  explanation: string[]
}

export function totalInteractions(signals: UsageSignals): number {
  return signals.clickCount + signals.readCount + signals.glanceCount
}

// Returns null until there is enough evidence to say anything. The caller falls
// back to DEFAULT_PROFILE in that case, so an under-observed user is never
// given a profile invented out of three data points.
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
      `${Math.round(glanceRatio * 100)}% of sections were scrolled past rather than read — revealing content a section at a time.`,
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
