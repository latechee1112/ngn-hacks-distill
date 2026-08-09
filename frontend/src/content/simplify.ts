import type { BlockAction, LayoutSettings } from '../types/analysis'
import {
  AD_HIDDEN_CLASS,
  DEEMPHASIZE_CLASS,
  isAdLike,
  isAdNetworkFrame,
  isFloatingVideoPromo,
  isPopupLike,
  isProtectedFromSimplification,
  isSponsoredLabel,
  isStickyOrFixed,
  isVisible,
  SECTION_HIDDEN_CLASS,
  UNSTICK_FIXED_CLASS,
  UNSTICK_STICKY_CLASS,
} from './dom-heuristics'
import { FF_ID_ATTR } from './extract'
import { pruneDetachedOriginals, restoreAllOriginal, saveOriginal } from './originalState'
import { applySiteRules, findSiteRule, HARD_BLUR_CLASS } from './siteRules'

const SIMPLIFIED_ATTR = 'data-distill-simplified'
const REDUCE_MOTION_ATTR = 'data-distill-reduce-motion'
// Set once the scan sweep (scanAnimation.ts) has actually finished, not the moment
// the classes below get added to the DOM. applyBackendActions()/applySimplification()
// run the instant the backend responds, which is usually well before the sweep's own
// minimum-visible-time + outro are done — the sweep is only a translucent wash, so
// without this gate the reading column narrowing and every dim/hide effect are plainly
// visible shifting underneath it, mid-animation, instead of appearing to resolve once
// the sweep clears. revealSimplification() is the only thing that sets this, called
// from content.ts as the sweep's onReveal callback.
const REVEAL_ATTR = 'data-distill-reveal'
// Set for the duration of the "Show original page" transition (restoreOriginalPageAnimated()
// in content.ts's happy path) - lets the blur/reading-column relax back to normal with a
// transition instead of the classes just vanishing outright, without touching what
// REVEAL_ATTR gates. See the note on the reveal-cascade rules below.
const RESTORING_ATTR = 'data-distill-restoring'
const STYLE_TAG_ID = 'distill-global-style'
const RESTORE_BTN_ID = 'distill-restore-button'
const RESTORE_BTN_EXIT_CLASS = 'distill-restore-button-exit'
// The final, un-transitioned display:none an ad gets once its fade (gated on
// REVEAL_ATTR, see that rule) has actually finished - see hideAds() and
// revealSimplification(), the only two places that ever add it.
const AD_COLLAPSE_CLASS = 'distill-ad-collapsed'
// Matches the fade's transition-duration above with a little slack.
const AD_FADE_SETTLE_MS = 500
const PRIMARY_CLASS = 'distill-primary-content'
const READING_COLUMN_CLASS = 'distill-reading-column'
const NEUTRAL_COLOR_CLASS = 'distill-neutral-color'
const PROGRESSIVE_CONTROLS_ID = 'distill-progressive-controls'
const SECTION_HEADING_SELECTOR = /^h[23]$/i
const BLUR_INTENSITY_PROP = '--distill-blur-intensity'
// Matches the sidepanel's new Intensity default (75%) - deemphasized content
// should already read as strongly blurred/censored the first time a page is
// simplified, before the user ever touches the slider.
const DEFAULT_BLUR_INTENSITY = 0.75
// Blur radius at 100% intensity. Strong enough to make text illegible (true
// "censoring") without needing an opaque overlay.
const MAX_BLUR_PX = 8

const NOISE_SELECTOR =
  'nav, aside, footer, [role="navigation"], [role="complementary"], [role="contentinfo"], ' +
  '[class*="ad" i], [id*="ad" i], ins, [class*="modal" i], [id*="modal" i], ' +
  '[class*="popup" i], [id*="popup" i], [class*="overlay" i]'

export interface SimplifyResult {
  primaryFound: boolean
  deemphasizedCount: number
  adsHidden: number
}

function findPrimaryContent(): Element | null {
  const candidates = document.querySelectorAll('main, article, [role="main"]')
  let best: Element | null = null
  let bestLen = 0
  candidates.forEach((el) => {
    if (!isVisible(el)) return
    const len = ((el as HTMLElement).innerText || '').length
    if (len > bestLen) {
      bestLen = len
      best = el
    }
  })
  return best
}

// A reading column only helps actual reading. Prose is text-dense with few links per
// character; a feed or results grid is the opposite — thousands of characters that are
// almost all link text, spread across cards. Narrowing the latter to 760px is what
// squeezes a YouTube home page into a strip.
const PROSE_MIN_TEXT = 600
const PROSE_MIN_PARAGRAPHS = 3
const PROSE_MIN_CHARS_PER_LINK = 60

function isProseLike(el: Element): boolean {
  const text = ((el as HTMLElement).innerText || '').length
  if (text < PROSE_MIN_TEXT) return false
  if (el.querySelectorAll('p').length < PROSE_MIN_PARAGRAPHS) return false
  const links = el.querySelectorAll('a[href]').length
  return text / Math.max(links, 1) >= PROSE_MIN_CHARS_PER_LINK
}

// Marks an element as the primary region, and gives it the reading column only if it
// actually reads like an article — and only if the page's site rule (if any) hasn't
// opted out, which is how a hand-tuned page keeps its own layout and gets nothing but
// the blur it asked for.
function markPrimary(el: Element): void {
  el.classList.add(PRIMARY_CLASS)
  if (findSiteRule()?.disableReadingColumn) return
  if (isProseLike(el)) el.classList.add(READING_COLUMN_CLASS)
}

// Prevents nested targets (e.g. an ad div inside an aside) from having opacity applied
// twice — CSS opacity compounds with ancestors, which would make nested targets vanish.
//
// Marks the candidates and asks the DOM which ones have a marked ancestor, rather than
// comparing every pair: the pairwise form is O(n²) contains() calls, and a feed page
// produces hundreds of candidates. closest() walks ancestors instead, so this is
// O(n × depth). The attribute is transient — set and removed inside this function —
// and the ad observer watches childList only, so it cannot retrigger anything.
const NESTING_MARK_ATTR = 'data-distill-nesting-mark'

function pruneNested(elements: Element[]): Element[] {
  elements.forEach((el) => el.setAttribute(NESTING_MARK_ATTR, ''))
  const outermost = elements.filter((el) => !el.parentElement?.closest(`[${NESTING_MARK_ATTR}]`))
  elements.forEach((el) => el.removeAttribute(NESTING_MARK_ATTR))
  return outermost
}

function collectNoiseTargets(primary: Element | null): Element[] {
  const targets = new Set<Element>()

  document.querySelectorAll(NOISE_SELECTOR).forEach((el) => {
    if (primary && (primary === el || primary.contains(el))) return
    if (!isVisible(el)) return
    if (isProtectedFromSimplification(el)) return
    if (isAdLike(el) || isPopupLike(el) || ['nav', 'aside', 'footer'].includes(el.tagName.toLowerCase())) {
      targets.add(el)
      return
    }
    const role = el.getAttribute('role')
    if (role === 'navigation' || role === 'complementary' || role === 'contentinfo') targets.add(el)
  })

  // Sticky/fixed chrome (promo bars, sticky headers) often isn't caught by the selector
  // above, so do a bounded pass over top-level containers by computed style. Safety-critical
  // fixed chrome — cookie/consent banners, warnings — must be excluded here specifically,
  // since "sticky/fixed" is exactly the shape a consent banner normally takes.
  document.querySelectorAll('body > *, header, div, section').forEach((el) => {
    if (targets.has(el)) return
    if (primary && (primary === el || primary.contains(el))) return
    if (!isVisible(el)) return
    if (isProtectedFromSimplification(el)) return
    if (isStickyOrFixed(el)) targets.add(el)
  })

  return pruneNested(Array.from(targets))
}

// --- Ads and sponsored content -------------------------------------------
// Ads are removed from view outright (display:none) rather than dimmed like other
// noise: a faded ad is still an ad competing for attention. Nothing is deleted —
// this is the same class-toggle + saveOriginal machinery as everything else, so
// restoreOriginalPage() brings them all back.

// Deliberately loose — every hit is re-checked with isAdLike(), which is the part
// that actually decides. Cheap to over-select here, expensive to miss.
const AD_CANDIDATE_SELECTOR =
  '[class*="ad" i], [id*="ad" i], [class*="sponsor" i], [id*="sponsor" i], ' +
  '[class*="promot" i], [id*="promot" i], [data-testid*="ad" i], [data-testid*="promot" i], ' +
  '[aria-label*="advertisement" i], [aria-label*="sponsored" i], ' +
  '[data-ad-client], [data-ad-slot], [data-ad-unit], ins, iframe, embed'

// Anything text-bearing small enough to be a badge. Excludes the structural tags a
// whole post card uses, so the walk-up below starts from the label, not the card.
const SPONSORED_LABEL_SELECTOR = 'span, div, p, a, small, em, strong, b, h4, h5, h6, label, li'

const CARD_TAGS = new Set(['article', 'li', 'section'])
const MAX_CARD_WALK_DEPTH = 8
// A container holding this much text is a feed/page region, not a single ad card.
const MAX_CARD_TEXT_LENGTH = 4000

// Three or more same-tag children means `parent` is the list and `child` is one entry —
// so `child` is the whole ad card and climbing any further would take out the feed.
function isFeedContainer(parent: Element, child: Element): boolean {
  return Array.from(parent.children).filter((c) => c.tagName === child.tagName).length >= 3
}

// A "Promoted" badge is a few nodes deep inside the post it labels; hiding just the
// badge would leave the ad itself sitting there. Climb to the post card and stop
// short of the feed that holds it.
function findAdCard(label: Element, primary: Element | null): Element {
  let el: Element = label
  for (let depth = 0; depth < MAX_CARD_WALK_DEPTH; depth++) {
    const parent = el.parentElement
    if (!parent || parent === document.body || parent === document.documentElement) break
    if (parent === primary || parent.tagName.toLowerCase() === 'main') break
    if (isProtectedFromSimplification(parent)) break
    if ((parent.textContent || '').length > MAX_CARD_TEXT_LENGTH) break
    if (isFeedContainer(parent, el)) break
    if (CARD_TAGS.has(parent.tagName.toLowerCase()) || parent.getAttribute('role') === 'article' || isAdLike(parent)) {
      return parent
    }
    el = parent
  }
  return el
}

// Candidates for isFloatingVideoPromo() to actually decide on - the player chrome
// that becomes position:fixed is rarely the video/branding element itself, so this
// starts from whichever descendant gives the plainest signal (a <video>, a Connatix
// <cnx> tag, or known player branding) and findFloatingVideoContainer() walks up
// from there to find the ancestor that's actually pinned.
const FLOATING_VIDEO_CANDIDATE_SELECTOR =
  'video, cnx, [class*="cnx" i], [class*="jwplayer" i], [class*="connatix" i], ' +
  '[class*="vidazoo" i], [class*="sticky-video" i], [class*="floating-player" i]'
const MAX_FLOATING_VIDEO_WALK_DEPTH = 6

function findFloatingVideoContainer(start: Element): Element | null {
  let el: Element | null = start
  for (let depth = 0; depth < MAX_FLOATING_VIDEO_WALK_DEPTH && el; depth++) {
    if (el !== document.body && el !== document.documentElement && isFloatingVideoPromo(el)) return el
    el = el.parentElement
  }
  return null
}

// `roots` scopes the scan. The first pass covers the whole document; rescans driven
// by the observer pass only the subtrees that were actually inserted, which is what
// keeps an infinite feed from re-querying every element on the page as you scroll.
function collectAdTargets(primary: Element | null, roots: Element[] = [document.documentElement]): Element[] {
  const targets = new Set<Element>()

  const consider = (el: Element) => {
    // Already resolved by an earlier pass — the expensive checks below can be skipped.
    if (el.classList.contains(AD_HIDDEN_CLASS) || el.closest(`.${AD_HIDDEN_CLASS}`)) return
    if (isProtectedFromSimplification(el)) return
    // The primary content itself is never an ad, and hiding an ancestor of it
    // would blank the page.
    if (primary && (el === primary || el.contains(primary))) return
    if (el === document.body || el === document.documentElement) return
    targets.add(el)
  }

  const scan = (root: Element, selector: string, handle: (el: Element) => void) => {
    // querySelectorAll skips the root itself, but an inserted node is very often
    // exactly the ad card, so it has to be tested directly.
    if (root.matches(selector)) handle(root)
    root.querySelectorAll(selector).forEach(handle)
  }

  roots.forEach((root) => {
    if (!root.isConnected) return
    scan(root, AD_CANDIDATE_SELECTOR, (el) => {
      if (isAdLike(el) || isAdNetworkFrame(el)) consider(el)
    })
    scan(root, SPONSORED_LABEL_SELECTOR, (el) => {
      if (isSponsoredLabel(el)) consider(findAdCard(el, primary))
    })
    scan(root, FLOATING_VIDEO_CANDIDATE_SELECTOR, (el) => {
      const container = findFloatingVideoContainer(el)
      if (container) consider(container)
    })
  })

  return pruneNested(Array.from(targets))
}

// --- Obvious secondary content -------------------------------------------
// Blurred locally in the same pre-filter pass as ads, for the same reason: a right
// rail of "Top Stories", a nav, a footer, a related-articles module is secondary on
// essentially every page, and waiting for the backend to say so leaves it sharp and
// competing with the article. The backend can still overrule any of it — see the
// emphasize/keep cases in applyBackendActions().

const SECONDARY_SELECTOR =
  'nav, aside, footer, [role="navigation"], [role="complementary"], [role="contentinfo"], ' +
  '[class*="sidebar" i], [id*="sidebar" i], [class*="rail" i], [id*="rail" i], ' +
  '[class*="related" i], [class*="recommend" i], [class*="trending" i], [class*="popular" i], ' +
  '[class*="most-read" i], [class*="top-stories" i], [class*="more-from" i], ' +
  '[class*="newsletter" i], [class*="subscribe" i], [class*="social" i], [class*="share" i], ' +
  '[class*="widget" i], [class*="promo" i]'

// A sidebar is often named nothing useful at all (AccuWeather's is "page-column-2"),
// so shape is the more reliable signal: a column sitting beside a much wider,
// much text-heavier sibling, carrying a handful of links. That is a rail, whatever
// it calls itself.
const SIDEBAR_MAX_WIDTH_RATIO = 0.6
const SIDEBAR_MAX_TEXT_RATIO = 0.5
const SIDEBAR_MIN_LINKS = 3
// Bounds the rect reads on very large documents. Generous — a deep page settles well
// under this — but keeps the pass from ever becoming the slow part of simplification.
const COLUMN_SCAN_BUDGET = 4000

function isSideBySide(a: DOMRect, b: DOMRect): boolean {
  const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  const horizontalOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  return verticalOverlap > Math.min(a.height, b.height) * 0.5 && horizontalOverlap <= 4
}

function collectSidebarColumns(): Element[] {
  const found: Element[] = []
  const queue: Element[] = [document.body]
  let budget = COLUMN_SCAN_BUDGET

  while (queue.length && budget > 0) {
    const node = queue.shift() as Element
    const children = Array.from(node.children).filter(isVisible)
    budget -= children.length

    if (children.length >= 2 && children.length <= 4) {
      const rects = children.map((c) => c.getBoundingClientRect())
      const texts = children.map((c) => ((c as HTMLElement).innerText || '').length)
      const mainIndex = texts.indexOf(Math.max(...texts))
      children.forEach((child, i) => {
        if (i === mainIndex) return
        if (!isSideBySide(rects[mainIndex], rects[i])) return
        if (rects[i].width > rects[mainIndex].width * SIDEBAR_MAX_WIDTH_RATIO) return
        if (texts[i] > texts[mainIndex] * SIDEBAR_MAX_TEXT_RATIO) return
        if (child.querySelectorAll('a[href]').length < SIDEBAR_MIN_LINKS) return
        found.push(child)
      })
    }

    children.forEach((c) => queue.push(c))
  }

  return found
}

// `spared` holds the blocks the backend explicitly ruled 'keep' or 'emphasize'. This
// pass runs after the backend's, so without that list it would re-blur, on shape alone,
// blocks the model just read the page and decided to keep — the exact precedence the
// emphasize/keep cases exist to establish.
function collectSecondaryTargets(primary: Element | null, spared: Element[] = []): Element[] {
  const targets = new Set<Element>()

  const consider = (el: Element) => {
    if (!isVisible(el)) return
    if (isProtectedFromSimplification(el)) return
    // Never blur the article itself, or anything wrapping it.
    if (primary && (el === primary || el.contains(primary) || primary.contains(el))) return
    if (el === document.body || el === document.documentElement) return
    if (el.closest(`.${AD_HIDDEN_CLASS}`)) return
    // Blurring an ancestor blurs the spared block with it, so overlap in either
    // direction disqualifies the target.
    if (spared.some((keep) => keep === el || keep.contains(el) || el.contains(keep))) return
    targets.add(el)
  }

  document.querySelectorAll(SECONDARY_SELECTOR).forEach(consider)
  collectSidebarColumns().forEach(consider)

  return pruneNested(Array.from(targets))
}

function deemphasizeSecondary(primary: Element | null, spared: Element[] = []): number {
  const targets = collectSecondaryTargets(primary, spared)
  targets.forEach((el) => {
    saveOriginal(el)
    el.classList.add(DEEMPHASIZE_CLASS)
    unstick(el)
  })
  return targets.length
}

// Stage 1 of simplification, run by content.ts BEFORE the page is extracted and sent
// to the backend. Everything unambiguous — "Promoted"/"Sponsored" badges, ad-network
// frames, ad-named containers — is resolved locally and instantly: the user sees the
// clutter go immediately instead of waiting on a network round-trip, and extractPage()
// then skips these blocks, so the backend only spends its judgement on the genuinely
// ambiguous rest of the page.
//
// Ads only. This pass used to blur secondary content too, which meant a guessed blur
// landed while the scan animation was still running and was then revised a second or
// two later when the analysis came back — the user watched the page shift under a
// sweep that is supposed to mean "still deciding". Nothing is blurred until the
// analysis is in; hiding an ad is a removal, not a blur, and nothing later revises it,
// so that part stays immediate.
export interface PrefilterResult {
  adsHidden: number
}

export function prefilterPage(): PrefilterResult {
  injectGlobalStyle()
  // Nothing is marked primary yet (the backend hasn't answered), so the local
  // article detector supplies the "don't touch this" region.
  const adsHidden = hideAds(findPrimaryContent())
  startAdObserver()
  return { adsHidden }
}

function hideAds(primary: Element | null, roots?: Element[]): number {
  const targets = collectAdTargets(primary, roots)
  targets.forEach((el) => {
    saveOriginal(el)
    el.classList.add(AD_HIDDEN_CLASS)
  })
  // The common case - the initial prefilter pass, well before the page has been
  // revealed - is handled by revealSimplification() instead: it re-scans for every
  // .${AD_HIDDEN_CLASS} once REVEAL_ATTR is actually set, this batch included. This
  // branch only matters for ads found *after* that (a feed loading a new sponsored
  // card via the mutation observer below) - REVEAL_ATTR is already set by then, so
  // nothing else is ever going to schedule this batch's collapse.
  if (targets.length && document.documentElement.hasAttribute(REVEAL_ATTR)) {
    scheduleAdCollapse(targets as HTMLElement[])
  }
  return targets.length
}

function scheduleAdCollapse(targets: HTMLElement[]): void {
  window.setTimeout(() => {
    targets.forEach((el) => {
      el.classList.add(AD_COLLAPSE_CLASS)
      el.style.removeProperty('--distill-reveal-delay')
    })
  }, AD_FADE_SETTLE_MS)
}

// Feeds stream new promoted posts in as you scroll, so a one-shot sweep only holds
// until the next page of results.
//
// Two things keep the rescan off the scroll path. It is debounced on idle rather than
// run per frame — a feed mutates continuously while scrolling, and a per-frame
// full-document sweep is felt as jank. And it scans only the subtrees that were
// actually inserted, not the whole page. Only childList is observed, so our own class
// changes can't re-trigger it.
const AD_RESCAN_DEBOUNCE_MS = 250
let adObserver: MutationObserver | null = null
let rescanTimer = 0
let pendingRoots: Element[] = []

function startAdObserver(): void {
  if (adObserver) return

  adObserver = new MutationObserver((records) => {
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) pendingRoots.push(node as Element)
      })
    })
    if (!pendingRoots.length) return

    window.clearTimeout(rescanTimer)
    rescanTimer = window.setTimeout(() => {
      const roots = pendingRoots
      pendingRoots = []
      hideAds(getPrimaryElement(), roots)
      // Feeds recycle nodes aggressively; without this the snapshot map would
      // hold every card the feed ever rendered.
      pruneDetachedOriginals()
    }, AD_RESCAN_DEBOUNCE_MS)
  })

  adObserver.observe(document.body, { childList: true, subtree: true })
}

function stopAdObserver(): void {
  adObserver?.disconnect()
  adObserver = null
  window.clearTimeout(rescanTimer)
  pendingRoots = []
}

// Sticky and fixed need different replacements to stay layout-neutral, and only the
// computed style knows which one this is — so the choice is made here, in JS, rather
// than by one blanket CSS rule.
function unstick(el: Element): void {
  const position = getComputedStyle(el).position
  if (position === 'fixed') el.classList.add(UNSTICK_FIXED_CLASS)
  else if (position === 'sticky') el.classList.add(UNSTICK_STICKY_CLASS)
}

function pauseAutoplayMedia(): void {
  document.querySelectorAll<HTMLMediaElement>('video[autoplay], audio[autoplay]').forEach((media) => {
    saveOriginal(media)
    media.pause()
    media.removeAttribute('autoplay')
    media.classList.add(DEEMPHASIZE_CLASS)
  })
}

function injectGlobalStyle(): void {
  if (document.getElementById(STYLE_TAG_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_TAG_ID
  style.textContent = `
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] body {
  line-height: 1.7 !important;
}
/* The narrow reading column is applied via its own class, NOT to every primary
   region: on a card grid (a YouTube feed, a search results page) forcing 760px
   and a larger font squeezes the grid into a narrow strip in the middle of an
   otherwise empty page. isProseLike() decides who gets this. Gated on REVEAL_ATTR,
   not just SIMPLIFIED_ATTR - see the note above that constant's declaration. */
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] .${READING_COLUMN_CLASS} {
  max-width: 760px !important;
  margin-left: auto !important;
  margin-right: auto !important;
  font-size: calc(1em * var(--distill-text-scale, 1.15)) !important;
  line-height: 1.75 !important;
  float: none !important;
}
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] .${READING_COLUMN_CLASS} p,
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] .${READING_COLUMN_CLASS} li {
  /* em, relative to the container's already-scaled font-size above - not an
     independent multiply, or textScale would compound quadratically. */
  margin-bottom: calc(1.1em * var(--distill-spacing, 1)) !important;
  font-size: 1.05em !important;
}
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] .${READING_COLUMN_CLASS} h1,
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] .${READING_COLUMN_CLASS} h2,
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] .${READING_COLUMN_CLASS} h3 {
  margin-top: 1.4em !important;
  margin-bottom: 0.6em !important;
}
/* Every target stores a pixel value measured before any target is changed. That
   makes the increase visible on normal body copy as well as captions, while
   avoiding compounded em/rem scaling in nested markup. */
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}][${MIN_TEXT_ATTR}] .${MIN_TEXT_CLASS} {
  font-size: var(${LARGER_TEXT_SIZE_PROP}) !important;
}
/* Everything that visibly reshapes the page - this included, see the ad rule below -
   waits for [${REVEAL_ATTR}]: deemphasizeSecondary() and hideAds() both run well before
   the scan sweep has actually finished (the sweep is a translucent wash, not an opaque
   cover, and the backend usually answers before the sweep's own hold/outro are done) -
   so without this gate the dim/blur/removal effects are plainly visible landing mid-sweep
   instead of appearing once the sweep resolves. See the note on REVEAL_ATTR's declaration. */
/* transition-delay is deliberately left out of the !important above: a shorthand's
   !important covers every sub-property it sets, including delay, which would bury
   the per-element stagger revealSimplification() writes to --distill-reveal-delay
   (see there). Nothing else styles that custom property, so leaving this one
   longhand non-important is safe - there's no host-page rule to lose a fight to. */
html[${REVEAL_ATTR}] .${DEEMPHASIZE_CLASS} {
  opacity: 0.4 !important;
  filter: blur(calc(var(${BLUR_INTENSITY_PROP}, ${DEFAULT_BLUR_INTENSITY}) * ${MAX_BLUR_PX}px)) !important;
  transition-property: opacity, filter !important;
  transition-duration: 0.6s, 0.6s !important;
  transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1), cubic-bezier(0.22, 1, 0.36, 1) !important;
  transition-delay: var(--distill-reveal-delay, 0ms);
}
html[${REVEAL_ATTR}] .${DEEMPHASIZE_CLASS}:hover {
  opacity: 0.85 !important;
  filter: none !important;
}
/* The "Show original page" undo, playing in reverse of the reveal cascade above:
   restoreOriginalPageAnimated() sets RESTORING_ATTR and a fresh --distill-reveal-delay
   per element (this time counting up from the bottom of the viewport, so the wave
   rolls upward - a visibly different motion from the top-down settle-in, not just the
   same animation backwards), then actually tears the classes down once the transition
   has had time to finish. Three attribute selectors beats [${REVEAL_ATTR}]'s two, so
   this simply outranks it - no need to fight the dim rule's !important a second time. */
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}][${RESTORING_ATTR}] .${DEEMPHASIZE_CLASS} {
  opacity: 1 !important;
  filter: none !important;
  transition-property: opacity, filter !important;
  transition-duration: 0.4s, 0.4s !important;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1), cubic-bezier(0.4, 0, 0.2, 1) !important;
  transition-delay: var(--distill-reveal-delay, 0ms);
}
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}][${RESTORING_ATTR}] .${READING_COLUMN_CLASS} {
  max-width: none !important;
  font-size: 1em !important;
  transition: max-width 0.4s cubic-bezier(0.4, 0, 0.2, 1), font-size 0.4s cubic-bezier(0.4, 0, 0.2, 1) !important;
}
/* The button's own exit: a soft dissolve instead of blinking out of existence the
   instant the DOM node is removed. */
#${RESTORE_BTN_ID}.${RESTORE_BTN_EXIT_CLASS} {
  opacity: 0 !important;
  transform: translateY(6px) scale(0.96) !important;
  transition: opacity 0.3s ease, transform 0.3s ease !important;
  pointer-events: none;
}
html[${REVEAL_ATTR}] .${DEEMPHASIZE_CLASS} input,
html[${REVEAL_ATTR}] .${DEEMPHASIZE_CLASS} button,
html[${REVEAL_ATTR}] .${DEEMPHASIZE_CLASS} select,
html[${REVEAL_ATTR}] .${DEEMPHASIZE_CLASS} textarea,
html[${REVEAL_ATTR}] .${DEEMPHASIZE_CLASS} a[href] {
  opacity: 1 !important;
  filter: none !important;
}
/* Hand-tuned per-site targets (siteRules.ts). Unlike .${DEEMPHASIZE_CLASS}, this does
   NOT exempt nested links/buttons — every one of these targets (Like button, team
   member links, tab links) is interactive, and blurring social proof only works if it
   covers those too. Hover still reveals, so nothing becomes unreachable, and
   pointer-events stay on so the revealed control is clickable. Gated on [${REVEAL_ATTR}]
   for the same reason as .${DEEMPHASIZE_CLASS} above - applySiteRules() also runs
   inside applyBackendActions(). */
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS},
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS} a[href],
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS} button,
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS} img {
  filter: blur(calc(var(${BLUR_INTENSITY_PROP}, ${DEFAULT_BLUR_INTENSITY}) * ${MAX_BLUR_PX}px)) !important;
  transition: filter 0.2s ease, opacity 0.2s ease !important;
}
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS} {
  opacity: 0.5 !important;
}
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS}:hover,
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS}:focus-within,
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS}:hover a[href],
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS}:focus-within a[href],
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS}:hover button,
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS}:focus-within button,
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS}:hover img,
html[${REVEAL_ATTR}] .${HARD_BLUR_CLASS}:focus-within img {
  filter: none !important;
  opacity: 1 !important;
}
/* Un-sticking must not change layout. position:static would drop a fixed header into
   normal flow, pushing everything below it down — on a site whose hero sizes itself
   against that header, the hero visibly grows by exactly the header's height.
   absolute/relative stop the element from following the scroll while it keeps the
   exact box it already had: fixed elements stay out of flow, sticky ones keep the
   space flow already reserved for them. Gated on [${REVEAL_ATTR}]: unstick() is called
   from the same post-backend passes as the rules above. */
html[${REVEAL_ATTR}] .${UNSTICK_FIXED_CLASS} {
  position: absolute !important;
  max-width: 100% !important;
}
html[${REVEAL_ATTR}] .${UNSTICK_STICKY_CLASS} {
  position: relative !important;
  top: auto !important;
  bottom: auto !important;
}
/* Text only - no filter. color has no effect on img/video/svg/canvas pixels to begin
   with, so there is nothing here that needs to steer around media the way the old
   grayscale() filter did. Has to repeat with a '*' descendant selector, not just rely
   on inheritance from the first rule: an inherited value only applies where nothing
   else in the cascade sets that property, and a host page's own link-color rule (no
   !important needed) counts as such a value - it wins over inheriting the ancestor's
   forced black regardless of how strong that ancestor's own !important is. */
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] .${NEUTRAL_COLOR_CLASS},
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] .${NEUTRAL_COLOR_CLASS} * {
  color: #000 !important;
}
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] .${PRIMARY_CLASS}.${NEUTRAL_COLOR_CLASS} a:not(form a):not(button a) {
  text-decoration: underline !important;
}
/* Glassmorphism, not a solid card: this floats over an arbitrary host page, so
   backdrop-filter actually has real content behind it to frost - a true glass
   effect, not a simulated one. Kept restrained on purpose: one blur radius, one
   thin border - no gradients, no color tint, no glow. No inset highlight: stacked
   on top of the real border it made the top edge read visibly thicker than the
   other three, since the border and the highlight sit right on top of each other
   only along that one edge. Text-align and flex-centering are explicit rather
   than left to the button's default, in case the host page's own CSS reset
   (button { text-align: inherit }, a body-level text-align, etc.) reaches in and
   pulls the label off-center. */
#${RESTORE_BTN_ID} {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 20, 22, 0.55);
  backdrop-filter: blur(16px) saturate(160%);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  padding: 14px 24px;
  min-height: 48px;
  font: 700 16px system-ui, sans-serif;
  text-align: center;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease;
}
#${RESTORE_BTN_ID}:hover {
  background: rgba(38, 38, 42, 0.65);
  border-color: rgba(255, 255, 255, 0.22);
}
#${RESTORE_BTN_ID}:focus-visible {
  outline: 3px solid #fff;
  outline-offset: 2px;
}
html[${SIMPLIFIED_ATTR}][${REVEAL_ATTR}] .${SECTION_HIDDEN_CLASS} {
  display: none !important;
}
/* Ads are found and marked the instant hideAds() runs - still the frontend's own
   local, independent detection, never the backend's - but the visible removal now
   waits for [${REVEAL_ATTR}] like everything else above, and fades rather than just
   vanishing. display:none can't be transitioned, so the fade (opacity + blur) plays
   first while the element is still in flow; JS adds .${AD_COLLAPSE_CLASS} once that
   fade has had time to finish (see revealSimplification() and hideAds()), which is
   the point .${AD_COLLAPSE_CLASS}'s plain display:none actually closes the gap - by
   then the element is already invisible, so that doesn't read as a second jump. */
html[${REVEAL_ATTR}] .${AD_HIDDEN_CLASS} {
  opacity: 0 !important;
  filter: blur(6px) !important;
  pointer-events: none !important;
  transition-property: opacity, filter !important;
  transition-duration: 0.4s, 0.4s !important;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1), cubic-bezier(0.4, 0, 0.2, 1) !important;
  transition-delay: var(--distill-reveal-delay, 0ms);
}
.${AD_COLLAPSE_CLASS} {
  display: none !important;
}
#${PROGRESSIVE_CONTROLS_ID} {
  position: fixed;
  bottom: 18px;
  left: 18px;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(20, 20, 22, 0.55);
  backdrop-filter: blur(16px) saturate(160%);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 14px;
  padding: 11px 16px;
  font: 700 15px/1.3 system-ui, sans-serif;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}
#${PROGRESSIVE_CONTROLS_ID} button {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: inherit;
  font: inherit;
  text-align: center;
  cursor: pointer;
  padding: 9px 15px;
  min-height: 44px;
  min-width: 44px;
  border-radius: 9px;
  transition: background-color 0.2s ease, border-color 0.2s ease;
}
#${PROGRESSIVE_CONTROLS_ID} button:disabled {
  opacity: 0.35;
  cursor: default;
}
#${PROGRESSIVE_CONTROLS_ID} button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.22);
}
#${PROGRESSIVE_CONTROLS_ID} button:focus-visible {
  outline: 3px solid #fff;
  outline-offset: 2px;
}
#${PROGRESSIVE_CONTROLS_ID} [data-role="label"] {
  opacity: 0.9;
  white-space: nowrap;
}
html[${SIMPLIFIED_ATTR}][${REDUCE_MOTION_ATTR}] *,
html[${SIMPLIFIED_ATTR}][${REDUCE_MOTION_ATTR}] *::before,
html[${SIMPLIFIED_ATTR}][${REDUCE_MOTION_ATTR}] *::after {
  animation-duration: 0.001ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.001ms !important;
  scroll-behavior: auto !important;
}
`
  document.head.appendChild(style)
}

function ensureRestoreButton(): void {
  if (document.getElementById(RESTORE_BTN_ID)) return
  const btn = document.createElement('button')
  btn.id = RESTORE_BTN_ID
  btn.type = 'button'
  btn.textContent = 'Show original page'
  btn.addEventListener('click', restoreOriginalPageAnimated)
  document.body.appendChild(btn)
}

export function hiddenAdCount(): number {
  return document.querySelectorAll(`.${AD_HIDDEN_CLASS}`).length
}

export function isSimplificationActive(): boolean {
  return document.documentElement.getAttribute(SIMPLIFIED_ATTR) === 'true'
}

// A gentle top-to-bottom cascade, echoing the beam that just swept the same
// direction: the closer to the top of the viewport a block is, the sooner it
// resolves. Capped well short of feeling laggy, and only spans the viewport — a
// long page's off-screen content all shares the cap rather than queuing up a
// wave the user would have to scroll to see finish. Shared by deemphasized and
// ad-hidden elements alike, so the whole page settles as one cascade rather than
// two staggered ones running out of sync with each other.
const REVEAL_STAGGER_MAX_MS = 260
const REVEAL_STAGGER_MS_PER_PX = 0.16
// Long enough to outlast REVEAL_STAGGER_MAX_MS plus the 0.6s transition it feeds,
// short enough that a later, unrelated class toggle (progressive reveal paging)
// can't inherit a stale delay from this pass.
const REVEAL_STAGGER_CLEANUP_MS = 1200

function setRevealDelay(el: HTMLElement): void {
  const top = Math.max(0, el.getBoundingClientRect().top)
  const delay = Math.min(REVEAL_STAGGER_MAX_MS, top * REVEAL_STAGGER_MS_PER_PX)
  el.style.setProperty('--distill-reveal-delay', `${Math.round(delay)}ms`)
}

// Called from content.ts once the scan sweep has actually finished (its onReveal
// callback) — see REVEAL_ATTR's declaration for why this is a separate step from
// applying the classes themselves.
export function revealSimplification(): void {
  // Read every rect before the attribute flips - once it does, the gated rules
  // land immediately and would be reading each other's post-reveal layout instead
  // of the settled pre-reveal one the user was just looking at.
  const deemphasizeTargets = Array.from(document.querySelectorAll<HTMLElement>(`.${DEEMPHASIZE_CLASS}`))
  const adTargets = Array.from(document.querySelectorAll<HTMLElement>(`.${AD_HIDDEN_CLASS}`))
  deemphasizeTargets.forEach(setRevealDelay)
  adTargets.forEach(setRevealDelay)

  document.documentElement.setAttribute(REVEAL_ATTR, 'true')

  // Layout rules (including the backend's reading-column text scale) are gated
  // on REVEAL_ATTR, so the pre-reveal pass cannot know the sizes users will
  // actually see. Re-measure synchronously now that those rules are active;
  // setLargerText() clears its old targets before reading, then applies a true
  // 30% increase over the final simplified sizes.
  if (isLargerTextOn()) setLargerText(true)

  window.setTimeout(() => {
    deemphasizeTargets.forEach((el) => el.style.removeProperty('--distill-reveal-delay'))
  }, REVEAL_STAGGER_CLEANUP_MS)

  // Ads use the same stagger, but their transition is shorter (0.4s vs 0.6s) and
  // ends in AD_COLLAPSE_CLASS rather than just sitting at its faded end state - see
  // the note on that class. scheduleAdCollapse() also fires the (fixed, 0ms-delay)
  // cleanup timer for a batch found by the mutation observer well after reveal, so
  // its own delay is capped in with the same REVEAL_STAGGER_MAX_MS margin here.
  if (adTargets.length) {
    window.setTimeout(() => {
      adTargets.forEach((el) => {
        el.classList.add(AD_COLLAPSE_CLASS)
        el.style.removeProperty('--distill-reveal-delay')
      })
    }, AD_FADE_SETTLE_MS + REVEAL_STAGGER_MAX_MS)
  }
}

export function applySimplification(): SimplifyResult {
  if (isSimplificationActive()) {
    return {
      primaryFound: !!document.querySelector(`.${PRIMARY_CLASS}`),
      deemphasizedCount: document.querySelectorAll(`.${DEEMPHASIZE_CLASS}`).length,
      adsHidden: document.querySelectorAll(`.${AD_HIDDEN_CLASS}`).length,
    }
  }

  const primary = findPrimaryContent()

  if (primary) {
    saveOriginal(primary)
    markPrimary(primary)
  }

  const targets = collectNoiseTargets(primary)
  targets.forEach((el) => {
    saveOriginal(el)
    el.classList.add(DEEMPHASIZE_CLASS)
    unstick(el)
  })

  const adsHidden = hideAds(primary)

  pauseAutoplayMedia()
  injectGlobalStyle()
  // The only place the hand-tuned blur is applied: after the analysis, so the page
  // never flickers mid-load, and last, so a backend 'keep'/'emphasize' on a block
  // that overlaps a hand-tuned region can't un-blur it — a hardcoded rule is a
  // deliberate choice and outranks any inference.
  applySiteRules()
  ensureRestoreButton()
  document.documentElement.setAttribute(SIMPLIFIED_ATTR, 'true')
  startAdObserver()

  return { primaryFound: !!primary, deemphasizedCount: targets.length, adsHidden }
}

function findByBlockId(blockId: string): Element | null {
  return document.querySelector(`[${FF_ID_ATTR}="${CSS.escape(blockId)}"]`)
}

// Renders the backend's transformation instructions - the backend never sends HTML/CSS/JS,
// only {blockId, action, priority, reason} per block plus page-wide layout numbers, so this
// is the only place that ever turns those instructions into actual DOM changes. Reuses the
// exact same saveOriginal()/class-toggle machinery as the local heuristic, so restoreOriginalPage()
// undoes either path identically.
export function applyBackendActions(actions: BlockAction[], layout: LayoutSettings): SimplifyResult {
  if (isSimplificationActive()) {
    return {
      primaryFound: !!document.querySelector(`.${PRIMARY_CLASS}`),
      deemphasizedCount: document.querySelectorAll(`.${DEEMPHASIZE_CLASS}`).length,
      adsHidden: document.querySelectorAll(`.${AD_HIDDEN_CLASS}`).length,
    }
  }

  let primaryFound = false
  let deemphasizedCount = 0
  // Blocks the backend explicitly wants left alone. Collected so the shape-based
  // secondary sweep below can't overrule the model that actually read the page.
  const spared: Element[] = []

  actions.forEach((action) => {
    const el = findByBlockId(action.blockId)
    if (!el) return
    saveOriginal(el)

    switch (action.action) {
      case 'emphasize':
        markPrimary(el)
        spared.push(el)
        primaryFound = true
        break
      case 'deemphasize':
        el.classList.add(DEEMPHASIZE_CLASS)
        unstick(el)
        deemphasizedCount++
        break
      case 'collapse':
        // Reuses the progressive-reveal "hidden" class - display:none, but still
        // present in the DOM and fully restorable, never deleted.
        el.classList.add(SECTION_HIDDEN_CLASS)
        break
      case 'keep':
        spared.push(el)
        break
      default:
        break
    }
  })

  document.documentElement.style.setProperty('--distill-text-scale', String(layout.textScale))
  document.documentElement.style.setProperty('--distill-spacing', String(layout.spacingMultiplier))
  document.documentElement.toggleAttribute(REDUCE_MOTION_ATTR, layout.reduceMotion)

  // Runs regardless of what the backend returned: ads are a client-side call the
  // extraction can't always see (cross-origin frames, feed units injected after
  // extraction), so this pass is not conditional on any action list.
  const primary = getPrimaryElement() ?? findPrimaryContent()
  const adsHidden = hideAds(primary)

  // The obvious-secondary sweep (rails, footers, "related" modules) used to run in the
  // pre-filter, before the analysis. It happens here now so that nothing blurs while
  // the scan animation is still playing — and since it lands after the actions, it is
  // told which blocks the backend spared so it can't overrule them.
  deemphasizedCount += deemphasizeSecondary(primary, spared)

  pauseAutoplayMedia()
  injectGlobalStyle()
  // The only place the hand-tuned blur is applied: after the analysis, so the page
  // never flickers mid-load, and last, so a backend 'keep'/'emphasize' on a block
  // that overlaps a hand-tuned region can't un-blur it — a hardcoded rule is a
  // deliberate choice and outranks any inference.
  applySiteRules()
  ensureRestoreButton()
  document.documentElement.setAttribute(SIMPLIFIED_ATTR, 'true')
  startAdObserver()

  if (layout.progressiveReveal && primaryFound) {
    enableProgressiveReveal()
  }

  return { primaryFound, deemphasizedCount, adsHidden }
}

function getPrimaryElement(): Element | null {
  return document.querySelector(`.${PRIMARY_CLASS}`)
}

function getPrimaryElements(): Element[] {
  return Array.from(document.querySelectorAll(`.${PRIMARY_CLASS}`))
}

function getColorReductionTargets(): Element[] {
  const primary = getPrimaryElements()
  if (primary.length > 0) return primary

  // Filtering <body> itself changes the containing block for position:fixed
  // descendants on some sites. Filtering its page-level children gives the
  // same rendered desaturation without moving sticky chrome or Distill's own
  // controls.
  const pageChildren = Array.from(document.body.children).filter(
    (el) => el.id !== RESTORE_BTN_ID && el.id !== PROGRESSIVE_CONTROLS_ID,
  )
  return pageChildren.length > 0 ? pageChildren : [document.body]
}

export function canReduceColorVariation(): boolean {
  return isSimplificationActive()
}

export function isColorVariationReduced(): boolean {
  const targets = getColorReductionTargets()
  return isSimplificationActive() && targets.length > 0 && targets.every((el) => el.classList.contains(NEUTRAL_COLOR_CLASS))
}

// Toggles desaturation across every primary region. There can be more than one
// when the backend emphasizes several blocks, so changing only querySelector's
// first match made the control appear ineffective on the rest of the content.
// Pages without a detected primary region use the body, keeping the preference
// useful for feeds, dashboards and search pages too.
export function setReduceColorVariation(enabled: boolean): boolean {
  if (!isSimplificationActive()) return false
  const targets = getColorReductionTargets()

  targets.forEach((el) => {
    saveOriginal(el)
    el.classList.toggle(NEUTRAL_COLOR_CLASS, enabled)
  })
  return true
}

// --- Live layout preferences ----------------------------------------------
// Reduce motion and larger text are user toggles, not analysis results. Both
// apply instantly to an already-simplified page and need no snapshot beyond
// what setLargerText() already takes per-element — restoreOriginalPage()
// clears both along with everything else.
//
// These deliberately win over the backend's suggested `layout` block: an
// explicit toggle is stronger intent than a profile-derived default.

export interface LayoutPreferences {
  reduceMotion: boolean
  largerText: boolean
}

export function isReduceMotionOn(): boolean {
  return document.documentElement.hasAttribute(REDUCE_MOTION_ATTR)
}

// Returns false when there is no simplified page to apply to — the caller keeps
// the preference stored and it takes effect on the next simplify.
export function setReduceMotion(enabled: boolean): boolean {
  if (!isSimplificationActive()) return false
  document.documentElement.toggleAttribute(REDUCE_MOTION_ATTR, enabled)
  return true
}

// A noticeable but restrained increase. Each target receives an absolute pixel
// value derived from its computed size so explicit site font sizes also respond.
const LARGER_TEXT_SCALE = 1.3
const MIN_TEXT_CLASS = 'distill-min-text-size'
const MIN_TEXT_ATTR = 'data-distill-larger-text'
const LARGER_TEXT_SIZE_PROP = '--distill-larger-font-size'
// Bounds the scan on a very large document, same reasoning as COLUMN_SCAN_BUDGET.
const MIN_TEXT_SCAN_BUDGET = 6000

// True only for elements with their own direct, non-whitespace text - the leaves
// worth measuring. A wrapping <div> around ten paragraphs inherits whatever size
// its children set; touching it too would be redundant at best and, since its
// own computed size is usually the *default* browser size rather than whatever
// small size its children actually render at, could floor text that was already
// fine.
function hasDirectText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim()) return true
  }
  return false
}

interface LargerTextTarget {
  element: Element
  fontSize: number
}

// Scoped to all primary content regions. Read every computed size before
// changing any element so nested em/rem text cannot compound as the scan runs.
function collectLargerTextTargets(): LargerTextTarget[] {
  const primary = getPrimaryElements()
  const roots = primary.length > 0 ? primary.filter((root) => !root.parentElement?.closest(`.${PRIMARY_CLASS}`)) : [document.body]
  const candidates = new Set<Element>()
  for (const root of roots) {
    candidates.add(root)
    root.querySelectorAll('*').forEach((el) => candidates.add(el))
  }

  const targets: LargerTextTarget[] = []
  for (const el of candidates) {
    if (targets.length >= MIN_TEXT_SCAN_BUDGET) break
    if (!hasDirectText(el) || isProtectedFromSimplification(el)) continue
    const fontSize = Number.parseFloat(getComputedStyle(el).fontSize)
    if (Number.isFinite(fontSize) && fontSize > 0) targets.push({ element: el, fontSize })
  }
  return targets
}

export function isLargerTextOn(): boolean {
  return document.documentElement.hasAttribute(MIN_TEXT_ATTR)
}

function clearLargerTextTargets(): void {
  document.querySelectorAll<HTMLElement>(`.${MIN_TEXT_CLASS}`).forEach((el) => {
    el.classList.remove(MIN_TEXT_CLASS)
    el.style.removeProperty(LARGER_TEXT_SIZE_PROP)
  })
}

// Re-scans from scratch every call so toggling off then back on, or reflow after
// the first pass, never leaves stale sizes or targets.
export function setLargerText(enabled: boolean): boolean {
  if (!isSimplificationActive()) return false
  clearLargerTextTargets()
  document.documentElement.toggleAttribute(MIN_TEXT_ATTR, enabled)
  if (enabled) {
    collectLargerTextTargets().forEach(({ element, fontSize }) => {
      saveOriginal(element)
      const el = element as HTMLElement
      el.style.setProperty(LARGER_TEXT_SIZE_PROP, `${Math.round(fontSize * LARGER_TEXT_SCALE * 100) / 100}px`)
      el.classList.add(MIN_TEXT_CLASS)
    })
  }
  return true
}

export function applyLayoutPreferences(prefs: LayoutPreferences): void {
  setReduceMotion(prefs.reduceMotion)
  setLargerText(prefs.largerText)
}

// --- Deemphasis blur intensity ---------------------------------------------
// Drives how strongly blurred/"censored" deemphasized (not collapsed) content
// looks. Fed by the sidepanel's Intensity slider (same 0-1 value already sent
// to the backend as simplificationStrength) - one dial controls both how much
// gets collapsed outright and how illegible whatever's merely deemphasized is.

export function getBlurIntensity(): number {
  const raw = document.documentElement.style.getPropertyValue(BLUR_INTENSITY_PROP)
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : DEFAULT_BLUR_INTENSITY
}

// fraction is 0-1, matching SimplifySettings.simplificationStrength.
export function setBlurIntensity(fraction: number): boolean {
  if (!isSimplificationActive()) return false
  document.documentElement.style.setProperty(BLUR_INTENSITY_PROP, String(fraction))
  return true
}

// --- Progressive reveal ---------------------------------------------------

export interface ProgressiveRevealResult {
  eligible: boolean
  totalSections: number
  currentIndex: number
}

let sections: Element[][] = []
let currentSectionIndex = 0

const HEADING_WRAPPER_TEXT_LIMIT = 150

// Some sites (current Wikipedia included) wrap each top-level section in its own
// container instead of leaving headings as flat siblings of their content — e.g.
// <section><h2>…</h2><p>…</p></section>. Wikipedia goes one level further and wraps
// just the heading itself too: <section><div class="mw-heading"><h2>…</h2></div>…</section>.
// Treat a container as a section wrapper if its first child either IS a heading, or is a
// short "heading wrapper" div/span (a handful of characters — enough for a heading, edit
// link, anchor) that itself contains one.
function isSectionWrapper(el: Element): boolean {
  const first = el.firstElementChild
  if (!first) return false
  if (SECTION_HEADING_SELECTOR.test(first.tagName)) return true
  const nestedHeading = first.querySelector('h2, h3')
  return !!nestedHeading && (first.textContent || '').length < HEADING_WRAPPER_TEXT_LIMIT
}

function isHeadingBearing(el: Element): boolean {
  return SECTION_HEADING_SELECTOR.test(el.tagName) || isSectionWrapper(el)
}

// Article containers are rarely flat — e.g. Wikipedia nests the real content
// several <div> levels below <main>. Descend into whichever child holds the most
// heading-bearing elements until we land on the level where sections (flat headings
// or per-section wrapper containers) are direct children.
function findContentRoot(root: Element, depth = 0): Element {
  if (depth > 6) return root

  const directHeadingBearingCount = Array.from(root.children).filter(isHeadingBearing).length
  if (directHeadingBearingCount >= 2) return root

  let best: Element | null = null
  let bestCount = 0
  for (const child of Array.from(root.children)) {
    const count = child.querySelectorAll('h2, h3').length
    if (count > bestCount) {
      bestCount = count
      best = child
    }
  }
  if (best && bestCount >= 2) return findContentRoot(best, depth + 1)

  return root
}

// Groups the content root's direct children into sections, handling both shapes:
// flat (headings interspersed with their content as siblings) and wrapped (each
// section pre-packaged in its own container). Never splits an element mid-section.
function buildSections(root: Element): Element[][] {
  const children = Array.from(root.children)
  const wrapperCount = children.filter(isSectionWrapper).length

  if (wrapperCount >= 2) {
    const groups: Element[][] = []
    const intro: Element[] = []
    let seenWrapper = false
    children.forEach((child) => {
      if (isSectionWrapper(child)) {
        if (!seenWrapper && intro.length) groups.push(intro)
        seenWrapper = true
        groups.push([child])
      } else if (!seenWrapper) {
        intro.push(child)
      } else {
        // Trailing content after the last wrapper (e.g. a "Categories" list) rides along with it.
        groups[groups.length - 1]?.push(child)
      }
    })
    if (!seenWrapper && intro.length) groups.push(intro)
    return groups
  }

  const groups: Element[][] = []
  let current: Element[] = []

  children.forEach((child) => {
    if (SECTION_HEADING_SELECTOR.test(child.tagName)) {
      if (current.length) groups.push(current)
      current = [child]
    } else {
      current.push(child)
    }
  })
  if (current.length) groups.push(current)

  return groups
}

function isProgressiveRevealActive(): boolean {
  return sections.length > 0
}

// Block-by-block reveal: only the current section is visible. Every other
// section — before or after — is fully hidden, not faded or peeking.
function applySectionVisibility(): void {
  sections.forEach((group, index) => {
    group.forEach((el) => {
      saveOriginal(el)
      el.classList.remove(DEEMPHASIZE_CLASS, SECTION_HIDDEN_CLASS)
      if (index !== currentSectionIndex) {
        el.classList.add(SECTION_HIDDEN_CLASS)
      }
    })
  })
}

function updateProgressiveControls(): void {
  const bar = document.getElementById(PROGRESSIVE_CONTROLS_ID)
  if (!bar) return
  const label = bar.querySelector('[data-role="label"]')
  if (label) label.textContent = `Section ${currentSectionIndex + 1} of ${sections.length}`
  const prevBtn = bar.querySelector<HTMLButtonElement>('[data-role="prev"]')
  const nextBtn = bar.querySelector<HTMLButtonElement>('[data-role="next"]')
  if (prevBtn) prevBtn.disabled = currentSectionIndex === 0
  if (nextBtn) nextBtn.disabled = currentSectionIndex === sections.length - 1
}

function goToSection(index: number): void {
  currentSectionIndex = Math.max(0, Math.min(index, sections.length - 1))
  applySectionVisibility()
  updateProgressiveControls()
  window.scrollTo({ top: 0, behavior: 'auto' })
}

function removeProgressiveControls(): void {
  document.getElementById(PROGRESSIVE_CONTROLS_ID)?.remove()
}

function ensureProgressiveControls(): void {
  if (document.getElementById(PROGRESSIVE_CONTROLS_ID)) {
    updateProgressiveControls()
    return
  }
  const bar = document.createElement('div')
  bar.id = PROGRESSIVE_CONTROLS_ID
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', 'Progressive reveal navigation')

  const prevBtn = document.createElement('button')
  prevBtn.type = 'button'
  prevBtn.dataset.role = 'prev'
  prevBtn.textContent = '‹ Previous'
  prevBtn.setAttribute('aria-label', 'Show previous section')
  prevBtn.addEventListener('click', () => goToSection(currentSectionIndex - 1))

  const label = document.createElement('span')
  label.dataset.role = 'label'
  label.setAttribute('aria-live', 'polite')

  const nextBtn = document.createElement('button')
  nextBtn.type = 'button'
  nextBtn.dataset.role = 'next'
  nextBtn.textContent = 'Next ›'
  nextBtn.setAttribute('aria-label', 'Show next section')
  nextBtn.addEventListener('click', () => goToSection(currentSectionIndex + 1))

  const showAllBtn = document.createElement('button')
  showAllBtn.type = 'button'
  showAllBtn.dataset.role = 'show-all'
  showAllBtn.textContent = 'Show All'
  showAllBtn.setAttribute('aria-label', 'Show all sections')
  showAllBtn.addEventListener('click', disableProgressiveReveal)

  bar.append(prevBtn, label, nextBtn, showAllBtn)
  document.body.appendChild(bar)
  updateProgressiveControls()
}

export function canUseProgressiveReveal(): boolean {
  return isSimplificationActive() && !!getPrimaryElement()
}

export function isProgressiveRevealOn(): boolean {
  return isProgressiveRevealActive()
}

export function enableProgressiveReveal(): ProgressiveRevealResult {
  const primary = getPrimaryElement()
  if (!isSimplificationActive() || !primary) {
    return { eligible: false, totalSections: 0, currentIndex: 0 }
  }

  const root = findContentRoot(primary)
  const built = buildSections(root)
  const headingSectionCount = built.filter((group) => isHeadingBearing(group[0])).length

  // Too few headings to meaningfully paginate — leave the article fully visible.
  if (headingSectionCount < 2) {
    sections = []
    return { eligible: false, totalSections: 0, currentIndex: 0 }
  }

  sections = built
  currentSectionIndex = 0
  applySectionVisibility()
  ensureProgressiveControls()

  return { eligible: true, totalSections: sections.length, currentIndex: currentSectionIndex }
}

export function disableProgressiveReveal(): void {
  sections.forEach((group) => {
    group.forEach((el) => el.classList.remove(DEEMPHASIZE_CLASS, SECTION_HIDDEN_CLASS))
  })
  sections = []
  currentSectionIndex = 0
  removeProgressiveControls()
}

// Instant and synchronous on purpose - this is the safety net content.ts's error
// path calls after a failed simplify, where the one thing that matters is landing
// in a coherent state immediately, not a pretty transition. restoreOriginalPageAnimated()
// below is what every user-initiated "Show original page" actually calls; it ends
// by calling this same function once the page is already visually back to normal,
// so the instant swap-back it does here goes unnoticed by then.
export function restoreOriginalPage(): void {
  stopAdObserver()
  disableProgressiveReveal()
  restoreAllOriginal()
  document.documentElement.removeAttribute(SIMPLIFIED_ATTR)
  document.documentElement.removeAttribute(REVEAL_ATTR)
  document.documentElement.removeAttribute(RESTORING_ATTR)
  document.documentElement.removeAttribute(REDUCE_MOTION_ATTR)
  document.documentElement.removeAttribute(MIN_TEXT_ATTR)
  document.documentElement.style.removeProperty('--distill-text-scale')
  document.documentElement.style.removeProperty('--distill-spacing')
  document.documentElement.style.removeProperty(BLUR_INTENSITY_PROP)
  document.getElementById(STYLE_TAG_ID)?.remove()
  document.getElementById(RESTORE_BTN_ID)?.remove()
}

// Distance from the bottom of the viewport, mirroring revealSimplification()'s
// distance-from-top - see the note on the RESTORING_ATTR rules for why the wave
// runs the opposite direction on the way out.
const RESTORE_STAGGER_MAX_MS = 220
const RESTORE_STAGGER_MS_PER_PX = 0.14
// The 0.4s transition-duration declared on the RESTORING_ATTR rules, plus the
// stagger's own cap, plus a small buffer - long enough that every element (even
// the last one in the wave) has visibly finished before the real teardown runs.
const RESTORE_SETTLE_MS = 400 + RESTORE_STAGGER_MAX_MS + 80

// The animated counterpart to restoreOriginalPage(), used by every user-initiated
// "Show original page" (the on-page button, and the sidepanel's DISTILL_RESTORE).
// Plays the blur/reading-column back to normal in a bottom-up wave and lets the
// floating button dissolve, then hands off to the plain synchronous restore once
// that's finished. Falls back to the instant version outright if the page was
// never actually revealed yet (a click landing in the brief window between the
// backend responding and the scan sweep's outro) - there's nothing to animate away
// in that case, and waiting RESTORE_SETTLE_MS anyway would just be a pointless stall.
export function restoreOriginalPageAnimated(): void {
  if (!document.documentElement.hasAttribute(REVEAL_ATTR)) {
    restoreOriginalPage()
    return
  }

  const viewportHeight = window.innerHeight
  document.querySelectorAll<HTMLElement>(`.${DEEMPHASIZE_CLASS}`).forEach((el) => {
    const top = Math.min(viewportHeight, Math.max(0, el.getBoundingClientRect().top))
    const delay = Math.min(RESTORE_STAGGER_MAX_MS, (viewportHeight - top) * RESTORE_STAGGER_MS_PER_PX)
    el.style.setProperty('--distill-reveal-delay', `${Math.round(delay)}ms`)
  })

  document.getElementById(RESTORE_BTN_ID)?.classList.add(RESTORE_BTN_EXIT_CLASS)
  document.documentElement.setAttribute(RESTORING_ATTR, 'true')

  window.setTimeout(restoreOriginalPage, RESTORE_SETTLE_MS)
}
