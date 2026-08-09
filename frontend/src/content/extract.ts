import type { BoundingBox, ExtractionResult, Landmark, PageBlock } from '../types/page'
import {
  isAdLike,
  isConsentControlLike,
  isPrefilteredAd,
  isPopupLike,
  isSidebarLike,
  isStickyOrFixed,
  isVisible,
  isWarningLike,
  PAYMENT_FIELD_PATTERN,
} from './dom-heuristics'

export const FF_ID_ATTR = 'data-distill-id'

const TEXT_MAX = 300
const LINK_GROUP_MIN_LINKS = 4

// Mirror of the backend's PageBlock field bounds. A value over these used to fail
// the whole request with 422 - every block on the page lost because one element
// had a long custom tag name. The server now truncates rather than rejects, but
// staying inside the contract here keeps the payload smaller and means an older
// backend build still works.
const TAG_MAX = 64
const ROLE_MAX = 64

// Hard ceiling on what one analysis request may contain. Two separate limits make
// this necessary, and the tighter one is time, not count:
//
//   - The backend rejects anything over max_blocks_per_request (150) with 413.
//   - Analysis latency is linear in block count. Measured against this backend
//     after the compact-response work: 60 blocks -> ~6.5s, 150 -> ~33s. (Before
//     it, 60 took 31s and 150 never returned inside the service worker's
//     ANALYZE_TIMEOUT_MS at all.)
//
// Either way a request that is too big means no LLM analysis: the extension falls
// back to the local heuristic and the user is never told why. So the budget is
// enforced here by dropping the least significant blocks. 60 keeps the round-trip
// under ten seconds. 150 now completes too, at ~33s - raise this only if that
// wait is acceptable, and never above the backend's own limit.
const MAX_BLOCKS = 60

// Icons, spacers, tracking pixels: media small enough that it carries no reading
// content. One article contributed 47 <svg> blocks this way, all of them chrome.
const MIN_MEDIA_AREA = 2500
const MEDIA_TAGS = ['img', 'svg', 'picture', 'video', 'iframe', 'embed']

// Broad net of tags/attributes worth inspecting. isExtractable() does the real filtering.
const CANDIDATE_SELECTOR = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'main', 'article', 'section', 'nav', 'aside', 'header', 'footer',
  'form', 'label', 'input', 'select', 'textarea', 'button', 'dialog',
  'img', 'picture', 'svg', 'video', 'iframe',
  '[role]',
  '[class*="ad" i]', '[id*="ad" i]',
  '[class*="modal" i]', '[id*="modal" i]',
  '[class*="popup" i]', '[id*="popup" i]',
  '[class*="overlay" i]',
  '[class*="sidebar" i]', '[id*="sidebar" i]',
].join(',')

const VIDEO_EMBED_PATTERN = /youtube|vimeo|player/i

// Tiny media is dropped outright rather than ranked: it is never the answer to
// "what is this page about", and every one of them costs a block of the budget.
// Ad-network frames are the exception - a 1x1 iframe is exactly what a tracker
// looks like, and the backend should still be told about it.
function isDecorativeMedia(el: Element): boolean {
  if (!MEDIA_TAGS.includes(el.tagName.toLowerCase())) return false
  if (isAdLike(el)) return false
  const rect = el.getBoundingClientRect()
  return rect.width * rect.height < MIN_MEDIA_AREA
}

function isExtractable(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (isPopupLike(el)) return true
  if (isAdLike(el)) return true
  if (isSidebarLike(el)) return true
  if (isStickyOrFixed(el)) return true
  if (
    [
      'nav', 'aside', 'article', 'section', 'header', 'footer', 'main',
      'form', 'dialog', 'label', 'input', 'select', 'textarea', 'button',
      'img', 'picture', 'svg', 'video', 'iframe', 'p',
    ].includes(tag)
  ) {
    return true
  }
  return /^h[1-6]$/.test(tag)
}

function findLinkGroups(): Element[] {
  const counts = new Map<Element, number>()
  document.querySelectorAll('a[href]').forEach((a) => {
    const parent = a.parentElement
    if (!parent) return
    counts.set(parent, (counts.get(parent) || 0) + 1)
  })
  const groups: Element[] = []
  counts.forEach((count, parent) => {
    if (count >= LINK_GROUP_MIN_LINKS && !parent.closest('nav')) {
      groups.push(parent)
    }
  })
  return groups
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const implicit: Record<string, string> = {
    nav: 'navigation',
    header: 'banner',
    footer: 'contentinfo',
    main: 'main',
    aside: 'complementary',
    button: 'button',
    form: 'form',
    img: 'img',
  }
  return implicit[el.tagName.toLowerCase()] || el.tagName.toLowerCase()
}

const LANDMARK_SELECTOR =
  'main, [role="main"], article, nav, [role="navigation"], aside, [role="complementary"], ' +
  'header, [role="banner"], footer, [role="contentinfo"], form, [role="form"], ' +
  'dialog, [role="dialog"], [aria-modal="true"]'

function tagLandmarkOf(el: Element): Landmark | undefined {
  const tag = el.tagName.toLowerCase()
  const role = el.getAttribute('role')
  if (tag === 'main' || role === 'main') return 'main'
  if (tag === 'article') return 'article'
  if (tag === 'nav' || role === 'navigation') return 'nav'
  if (tag === 'aside' || role === 'complementary') return 'aside'
  if (tag === 'header' || role === 'banner') return 'header'
  if (tag === 'footer' || role === 'contentinfo') return 'footer'
  if (tag === 'form' || role === 'form') return 'form'
  if (tag === 'dialog' || role === 'dialog' || el.getAttribute('aria-modal') === 'true') return 'dialog'
  return undefined
}

// Maps to the backend's landmark vocabulary: main, article, nav, aside,
// header, footer, form, dialog, other. Non-landmark elements get undefined
// rather than "other" so the field is only set when it's actually meaningful.
//
// This is the block's containing region, not just "is this element itself a
// <main>/<article> tag" - closest() walks up to the nearest ancestor (or el
// itself) that matches. Checking only the element's own tag/role meant
// every block nested inside <main>/<article> (i.e. nearly everything on a
// real page - a post's image, a paragraph, a heading) got landmark:
// undefined, since only the single outer <main> element itself ever
// qualified. That starved the backend's "landmark in main/article ->
// Essential" rule (rule_engine.py's classify_block) of the one signal it
// needs, leaving image-only blocks in particular (no text for the LLM to
// judge relevance from either) to fall through as Uncertain and get
// misjudged as Distracting - the reported bug of a post's own photo getting
// blurred. rule_engine.classify_block checks explicit ad/promo/autoplay
// signals before this landmark check specifically so an ad nested inside an
// <article> still gets flagged as an ad rather than inheriting Essential.
function landmarkOf(el: Element): Landmark | undefined {
  const host = el.closest(LANDMARK_SELECTOR)
  return host ? tagLandmarkOf(host) : undefined
}

function isInteractiveOf(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true
  const role = el.getAttribute('role')
  if (role && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch'].includes(role)) return true
  if (el.hasAttribute('onclick')) return true
  const tabIndex = (el as HTMLElement).tabIndex
  if (tabIndex !== undefined && tabIndex >= 0) return true
  return getComputedStyle(el).cursor === 'pointer'
}

function isFormControlOf(el: Element): boolean {
  return ['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())
}

function isFormInstructionOf(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag === 'label' || tag === 'legend') return true
  if (!el.closest('form')) return false
  return tag === 'p' || tag === 'small'
}

function isPasswordFieldOf(el: Element): boolean {
  return el.tagName.toLowerCase() === 'input' && (el as HTMLInputElement).type === 'password'
}

function isPaymentFieldOf(el: Element): boolean {
  if (!isFormControlOf(el)) return false
  const autocomplete = el.getAttribute('autocomplete') || ''
  if (autocomplete.startsWith('cc-')) return true
  const hay = [
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
  ]
    .filter(Boolean)
    .join(' ')
  return PAYMENT_FIELD_PATTERN.test(hay)
}

function isAutoplayMediaOf(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if ((tag === 'video' || tag === 'audio') && (el as HTMLMediaElement).autoplay) return true
  if (tag === 'iframe') {
    const src = el.getAttribute('src') || ''
    return VIDEO_EMBED_PATTERN.test(src) && /autoplay=1/i.test(src)
  }
  return false
}

// Viewport-relative fractions (0-1), matching the backend's BoundingBox contract -
// getBoundingClientRect() is already viewport-relative, so no scroll offset is added.
// Clamped because elements partially or fully outside the viewport otherwise produce
// values <0 or >1, which the backend rejects outright.
function boundingBoxOf(el: Element): BoundingBox {
  const rect = el.getBoundingClientRect()
  const vw = window.innerWidth || document.documentElement.clientWidth || 1
  const vh = window.innerHeight || document.documentElement.clientHeight || 1
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  return {
    x: clamp(rect.left / vw),
    y: clamp(rect.top / vh),
    width: clamp(rect.width / vw),
    height: clamp(rect.height / vh),
  }
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > TEXT_MAX ? `${collapsed.slice(0, TEXT_MAX)}…` : collapsed
}

function getAssociatedLabelText(el: Element): string {
  const id = el.id
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)
    if (label) return label.textContent || ''
  }
  const closestLabel = el.closest('label')
  return closestLabel?.textContent || ''
}

// Never reads .value - only label/placeholder/aria text, so field contents (passwords,
// payment numbers, any user input) never leave the page.
function textOf(el: Element): string {
  if (isFormControlOf(el)) {
    const label = getAssociatedLabelText(el) || el.getAttribute('placeholder') || el.getAttribute('aria-label') || ''
    return truncate(label)
  }
  const text = (el as HTMLElement).innerText ?? el.textContent ?? ''
  return truncate(text)
}

function detectSensitiveForms(): boolean {
  if (document.querySelector('input[type="password"]')) return true
  const fields = document.querySelectorAll('input, select, textarea')
  for (const field of fields) {
    const autocomplete = field.getAttribute('autocomplete') || ''
    if (autocomplete.startsWith('cc-')) return true
    const hay = [
      field.getAttribute('name'),
      field.getAttribute('id'),
      field.getAttribute('placeholder'),
      field.getAttribute('aria-label'),
    ]
      .filter(Boolean)
      .join(' ')
    if (PAYMENT_FIELD_PATTERN.test(hay)) return true
  }
  return false
}

function nextIdCounter(): number {
  let max = 0
  document.querySelectorAll(`[${FF_ID_ATTR}]`).forEach((el) => {
    const match = el.getAttribute(FF_ID_ATTR)?.match(/^ff-(\d+)$/)
    if (match) max = Math.max(max, parseInt(match[1], 10))
  })
  return max + 1
}

function buildBlock(el: Element, counter: { n: number }, opts: { repeatedLink?: boolean } = {}): PageBlock {
  let id = el.getAttribute(FF_ID_ATTR)
  if (!id) {
    id = `ff-${counter.n++}`
    el.setAttribute(FF_ID_ATTR, id)
  }
  return {
    blockId: id,
    // Clamped to the backend's PageBlock bounds. Web components have no length
    // convention - YouTube renders <yt-thumbnail-bottom-overlay-view-model>, 38
    // characters - and the server's own limits are what the payload has to fit.
    tag: el.tagName.toLowerCase().slice(0, TAG_MAX),
    landmark: landmarkOf(el),
    role: roleOf(el).slice(0, ROLE_MAX),
    text: textOf(el),
    isInteractive: isInteractiveOf(el),
    isFormControl: isFormControlOf(el),
    isFormInstruction: isFormInstructionOf(el),
    isPasswordField: isPasswordFieldOf(el),
    isPaymentField: isPaymentFieldOf(el),
    isConsentControl: isConsentControlLike(el),
    isWarning: isWarningLike(el),
    isAd: isAdLike(el),
    isStickyPromo: isStickyOrFixed(el) || isPopupLike(el),
    isAutoplayMedia: isAutoplayMediaOf(el),
    isRepeatedLink: !!opts.repeatedLink,
    visible: true,
    boundingBox: boundingBoxOf(el),
  }
}

// Safety-critical blocks are never candidates for eviction: the backend's whole
// protection contract (never collapse a consent banner, a warning, a password or
// payment field) depends on those blocks being in the payload it reasons over.
function isSafetyCritical(block: PageBlock): boolean {
  return block.isPasswordField || block.isPaymentField || block.isConsentControl || block.isWarning
}

// What survives the budget. Screen area is the primary signal - a page's real
// content is the part that occupies it - with text length as the tiebreaker
// between equally sized blocks and a small nudge for semantic landmarks. Ads and
// sticky promos are scored too rather than dropped: knowing where the noise is
// is what lets the backend deemphasize it.
function blockScore(block: PageBlock): number {
  if (isSafetyCritical(block)) return Number.POSITIVE_INFINITY
  const box = block.boundingBox
  const area = box ? box.width * box.height : 0
  const textWeight = Math.min(block.text.length, TEXT_MAX) / TEXT_MAX
  const landmarkBonus = block.landmark ? 0.15 : 0
  return area * 2 + textWeight + landmarkBonus
}

// Trims to MAX_BLOCKS by significance, then restores document order - the backend
// keys off blockId so order is not load-bearing, but a payload that reads
// top-to-bottom gives the LLM the page's actual structure to reason about.
function applyBlockBudget(blocks: PageBlock[]): PageBlock[] {
  if (blocks.length <= MAX_BLOCKS) return blocks
  const order = new Map(blocks.map((b, i) => [b.blockId, i]))
  return blocks
    .slice()
    .sort((a, b) => blockScore(b) - blockScore(a))
    .slice(0, MAX_BLOCKS)
    .sort((a, b) => (order.get(a.blockId) ?? 0) - (order.get(b.blockId) ?? 0))
}

export function extractPage(): ExtractionResult {
  const seen = new Set<Element>()
  const blocks: PageBlock[] = []
  const counter = { n: nextIdCounter() }

  // Blocks the local pre-filter already resolved as ads are dropped here rather than
  // sent and re-judged: the decision is made, and leaving them out keeps the payload
  // (and the LLM's attention) on the parts that actually need a judgement call. They
  // are only display:none, so isVisible() would already exclude most of them - this
  // also covers their still-laid-out descendants.
  document.querySelectorAll(CANDIDATE_SELECTOR).forEach((el) => {
    if (seen.has(el) || !isVisible(el) || !isExtractable(el) || isPrefilteredAd(el)) return
    if (isDecorativeMedia(el)) return
    seen.add(el)
    blocks.push(buildBlock(el, counter))
  })

  findLinkGroups().forEach((el) => {
    if (seen.has(el) || !isVisible(el) || isPrefilteredAd(el)) return
    seen.add(el)
    blocks.push(buildBlock(el, counter, { repeatedLink: true }))
  })

  const budgeted = applyBlockBudget(blocks)
  if (budgeted.length < blocks.length) {
    console.log(`[Distill] extraction trimmed ${blocks.length} blocks to ${budgeted.length} to fit the analysis budget`)
  }

  return {
    url: window.location.href,
    extractedAt: Date.now(),
    blocks: budgeted,
    hasSensitiveForms: detectSensitiveForms(),
  }
}
