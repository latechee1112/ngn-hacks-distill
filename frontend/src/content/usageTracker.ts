// Collection half of the passive visual profile: the listeners that watch
// ordinary browsing and accumulate counters. The storage shape and the rules
// that turn those counters into a VisualProfile live in shared/usageProfile.ts,
// so pages with no DOM to observe (the popup, which only displays a profile)
// can read one without pulling this file's DOM machinery into their bundle.
//
// See shared/usageProfile.ts for the privacy contract: only integer counters
// are ever written, never URLs or page text.

import {
  EMPTY_SIGNALS,
  USAGE_SIGNALS_VERSION,
  USAGE_STORAGE_KEY,
  loadUsageSignals,
  type UsageSignals,
} from '../shared/usageProfile'
import { isAdLike, isSidebarLike, isStickyOrFixed } from './dom-heuristics'

// A region visible this long was read; below GLANCE_MIN_MS it was not really
// seen at all and is ignored rather than counted as a glance (scrolling fast
// through a long page would otherwise manufacture hundreds of "glances").
const READ_MS = 2000
const GLANCE_MIN_MS = 400

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
