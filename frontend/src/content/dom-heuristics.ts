// Marks a block the local pre-filter already resolved as an ad. Lives here rather than
// in simplify.ts so extract.ts can skip these without importing simplify (which imports
// extract) - and so the "is this filtered?" check is one shared definition.
export const AD_HIDDEN_CLASS = 'distill-ad-hidden'

// Blur/dim applied to secondary content. Lives here for the same reason as the class
// above: modules other than simplify.ts (siteRules.ts) need to reference it without
// importing simplify, which imports them.
export const DEEMPHASIZE_CLASS = 'distill-deemphasize'
// display:none, applied by a backend 'collapse' action and by progressive reveal.
export const SECTION_HIDDEN_CLASS = 'distill-section-hidden'
// Layout-neutral replacements for position:fixed / position:sticky.
export const UNSTICK_FIXED_CLASS = 'distill-unstick-fixed'
export const UNSTICK_STICKY_CLASS = 'distill-unstick-sticky'

export function isPrefilteredAd(el: Element): boolean {
  return !!el.closest(`.${AD_HIDDEN_CLASS}`)
}

export const AD_PATTERN = /(^|[-_ ])ad([-_ ]|$)|advert|sponsor|promoted|adsbygoogle/i
// Third-party ad/tracking hosts, matched against iframe/ins src attributes.
export const AD_NETWORK_PATTERN =
  /doubleclick|googlesyndication|googleadservices|googletagservices|adservice|adnxs|amazon-adsystem|taboola|outbrain|criteo|pubmatic|rubiconproject|moatads|zedo|adroll|media\.net/i
// The visible label a feed puts on a paid unit. Matched against an element's
// *entire* trimmed text, so it only ever fires on the small badge itself
// ("Promoted", "Sponsored · claude.com") and never on an article that merely
// mentions the word somewhere in its body.
// Anchored at the start, with an optional short tail for the forms that name the
// advertiser: "Promoted by Acme", "Sponsored · claude.com", "Ads by Google".
export const SPONSORED_LABEL_PATTERN =
  /^(?:promoted|sponsored|advertisement|paid (?:partnership|post|content)|ads? by\b)(?:[\s·•|:\-–—]+.{0,40})?$/i
// One separator-delimited segment that is nothing but the badge word.
export const SPONSORED_SEGMENT_PATTERN = /^(?:promoted|sponsored|advertisement|ad)$/i
// Long enough for "Sponsored · Some Brand Name", short enough that no real post body fits.
const SPONSORED_LABEL_MAX_LEN = 60
export const POPUP_PATTERN = /modal|popup|overlay|lightbox/i
export const SIDEBAR_PATTERN = /sidebar/i
export const CONSENT_CLASS_PATTERN = /cookie|consent|gdpr/i
export const CONSENT_TEXT_PATTERN = /cookie|consent|gdpr|privacy preference/i
export const CONSENT_ACTION_PATTERN =
  /accept(?:\s+all)?|reject(?:\s+all)?|decline|allow all|manage (?:cookie|preference)|cookie setting|got it|i agree|^agree$/i
export const WARNING_PATTERN = /warning|error|alert/i
export const PAYMENT_FIELD_PATTERN = /card.?number|cvv|cvc|expir|credit.?card/i

export function classNameString(el: Element): string {
  const raw = typeof el.className === 'string' ? el.className : ''
  return `${raw} ${el.id || ''}`
}

export function isVisible(el: Element): boolean {
  const htmlEl = el as HTMLElement
  if (htmlEl.hidden) return false
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const cs = getComputedStyle(el)
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'
}

// Class/id naming is the main signal, but feed apps (Reddit, X, LinkedIn) name their
// nodes by test id or label them for screen readers instead, so those count too.
export function isAdLike(el: Element): boolean {
  const hay = [
    classNameString(el),
    el.getAttribute('data-testid') || '',
    el.getAttribute('data-test-id') || '',
    el.getAttribute('aria-label') || '',
  ].join(' ')
  if (AD_PATTERN.test(hay)) return true
  if (el.hasAttribute('data-ad-client') || el.hasAttribute('data-ad-slot') || el.hasAttribute('data-ad-unit')) return true
  return el.tagName.toLowerCase() === 'ins' && classNameString(el).includes('adsbygoogle')
}

// An iframe/script served by a known ad network - the actual creative, whatever the
// surrounding markup happens to be named.
export function isAdNetworkFrame(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag !== 'iframe' && tag !== 'ins' && tag !== 'embed') return false
  const src = el.getAttribute('src') || el.getAttribute('data-src') || ''
  return AD_NETWORK_PATTERN.test(src) || /^google_ads/i.test(el.id || '')
}

// True when this element IS the little "Promoted"/"Sponsored" badge - not when it
// merely contains one. Callers walk up from here to find the post it belongs to.
export function isSponsoredLabel(el: Element): boolean {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
  if (!text || text.length > SPONSORED_LABEL_MAX_LEN) return false
  if (SPONSORED_LABEL_PATTERN.test(text)) return true
  // Feeds often fuse the badge into the byline row - "anthropic-ai · Promoted",
  // "Some Brand • Sponsored". Checking each separator-delimited segment catches those
  // without matching prose, since a whole segment has to be exactly the badge word.
  return text.split(/[·•|]|\s[–—-]\s/).some((segment) => SPONSORED_SEGMENT_PATTERN.test(segment.trim()))
}

// A modal/popup/overlay is always some kind of container - never literally a
// leaf media tag itself. Reddit (and other galleries) name a plain, perfectly
// normal post image "...-lightbox-img" because clicking it OPENS a lightbox;
// that is not the same thing as the image BEING a popup. Without this
// exemption, POPUP_PATTERN's bare substring match on "lightbox" flagged the
// post's own photo, which extract.ts's isStickyPromo (and, from there, the
// backend's classify_block) treats as a hard "distracting" signal - the
// actual cause of a post's main image getting blurred.
const POPUP_EXEMPT_TAGS = new Set(['img', 'picture', 'video', 'source', 'svg', 'audio'])

export function isPopupLike(el: Element): boolean {
  if (POPUP_EXEMPT_TAGS.has(el.tagName.toLowerCase())) return false
  const cls = classNameString(el)
  return POPUP_PATTERN.test(cls) || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true'
}

export function isSidebarLike(el: Element): boolean {
  const cls = classNameString(el)
  return el.tagName.toLowerCase() === 'aside' || SIDEBAR_PATTERN.test(cls) || el.getAttribute('role') === 'complementary'
}

export function isStickyOrFixed(el: Element): boolean {
  const position = getComputedStyle(el).position
  return position === 'fixed' || position === 'sticky'
}

// Branding for the floating-video-ad players outbrain/taboola-syndicated content
// commonly injects (Connatix's own markup literally uses a <cnx> tag and "cnx-ui-"
// class prefix - see isFloatingVideoPromo). Checked before falling back to pure
// geometry, since a name hit is a stronger signal than shape alone.
export const FLOATING_MEDIA_PATTERN =
  /\bcnx\b|connatix|jwplayer|jw-player|vidazoo|floating-player|sticky-video|video-sticky|mini-?player/i

const FLOATING_VIDEO_MAX_WIDTH = 440
const FLOATING_VIDEO_MAX_HEIGHT = 320
// How close to an edge counts as "anchored" there, not just coincidentally nearby.
const FLOATING_VIDEO_CORNER_MARGIN = 48

// The small, fixed/sticky, corner-pinned video player outbrain/taboola/connatix-style
// content-recommendation widgets float over a page (see the screenshot on the PR/issue
// this shipped for: a muted autoplaying clip bottom-right, its own play/pause and close
// controls, sitting on top of "Show original page"). Geometry over naming, like
// collectSidebarColumns() uses for rails elsewhere - a player like this is rarely
// classed anything an AD_PATTERN substring match would catch, but "small, pinned to a
// corner, plays video, isn't the page's own content" is a shape that holds regardless
// of which vendor's script placed it there.
export function isFloatingVideoPromo(el: Element): boolean {
  if (!isStickyOrFixed(el)) return false

  const hasVideo = el.tagName.toLowerCase() === 'video' || !!el.querySelector('video')
  if (!hasVideo && !FLOATING_MEDIA_PATTERN.test(classNameString(el)) && !el.querySelector('cnx, [class*="cnx" i]')) {
    return false
  }

  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  if (rect.width > FLOATING_VIDEO_MAX_WIDTH || rect.height > FLOATING_VIDEO_MAX_HEIGHT) return false

  const nearRight = window.innerWidth - rect.right <= FLOATING_VIDEO_CORNER_MARGIN
  const nearLeft = rect.left <= FLOATING_VIDEO_CORNER_MARGIN
  const nearBottom = window.innerHeight - rect.bottom <= FLOATING_VIDEO_CORNER_MARGIN
  const nearTop = rect.top <= FLOATING_VIDEO_CORNER_MARGIN
  return (nearRight || nearLeft) && (nearBottom || nearTop)
}

function isInteractiveish(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return true
  const role = el.getAttribute('role')
  return !!role && ['button', 'link'].includes(role)
}

// Just the accept/reject/manage action wording - real banner buttons ("Accept", "Reject
// All", "Manage preferences") virtually never restate "cookie"/"consent" in the button's
// own text, so this stays intentionally topic-agnostic. Used as a sub-check by
// isConsentBannerLike, which supplies the surrounding topic context itself.
function hasConsentActionWording(el: Element): boolean {
  if (!isInteractiveish(el)) return false
  const hay = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`
  return CONSENT_ACTION_PATTERN.test(hay)
}

// A single control (button/link) that is self-sufficient evidence of being a cookie/
// consent action on its own - both the action wording AND the cookie/consent topic are
// present together, e.g. "Accept All Cookies" or a button classed "cookie-accept-btn".
// Stricter than hasConsentActionWording on purpose: without banner context, a bare
// "Accept"/"Agree" button is just as likely to belong to a ToS modal or newsletter signup.
export function isConsentControlLike(el: Element): boolean {
  if (!hasConsentActionWording(el)) return false
  const hay = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`
  return CONSENT_TEXT_PATTERN.test(hay) || CONSENT_CLASS_PATTERN.test(classNameString(el))
}

// A container that IS (or wraps) a cookie/consent notice - the shape that gets caught
// by generic "sticky/fixed chrome" sweeps and must be excluded from them. Matches on
// class/id naming, dialog role + consent-flavored aria-label, or consent-flavored banner
// text paired with a nested accept/reject/manage button (the button need not itself repeat
// "cookie"/"consent" - the banner's own text already establishes the topic).
export function isConsentBannerLike(el: Element): boolean {
  const cls = classNameString(el)
  if (CONSENT_CLASS_PATTERN.test(cls)) return true

  const role = el.getAttribute('role')
  const ariaLabel = el.getAttribute('aria-label') || ''
  if ((role === 'dialog' || role === 'alertdialog') && CONSENT_TEXT_PATTERN.test(ariaLabel)) return true

  const text = el.textContent || ''
  if (!CONSENT_TEXT_PATTERN.test(text) && !CONSENT_TEXT_PATTERN.test(ariaLabel)) return false
  return Array.from(el.querySelectorAll('button, a, [role="button"]')).some(hasConsentActionWording)
}

// role=alert / aria-live=assertive / warning-flavored class naming - form validation
// errors, safety warnings, etc.
export function isWarningLike(el: Element): boolean {
  const role = el.getAttribute('role')
  if (role === 'alert' || role === 'alertdialog') return true
  if (el.getAttribute('aria-live') === 'assertive') return true
  return WARNING_PATTERN.test(classNameString(el))
}

// A password or payment field anywhere inside the element - safety-critical per the
// backend's is_safety_critical() contract, so containers holding one must never collapse.
export function containsSensitiveField(el: Element): boolean {
  if (el.querySelector('input[type="password"]')) return true
  const fields = el.querySelectorAll('input, select, textarea')
  for (const field of Array.from(fields)) {
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

const PROTECTED_DESCENDANT_SELECTOR =
  '[class*="cookie" i], [class*="consent" i], [class*="gdpr" i], ' +
  '[role="dialog"], [role="alertdialog"], [role="alert"], [aria-live="assertive"]'

// Safety-critical per the backend's is_safety_critical()/is_protected_from_collapse()
// contract: consent banners, warnings, and anything holding a password/payment field
// must never be dimmed, hidden, or collapsed by simplification. Also true if a protected
// element is merely nested inside - dimming an ancestor's opacity dims its children too,
// so a container wrapping a cookie banner is just as unsafe to target as the banner itself.
export function isProtectedFromSimplification(el: Element): boolean {
  if (isConsentBannerLike(el) || isConsentControlLike(el) || isWarningLike(el) || containsSensitiveField(el)) {
    return true
  }
  return !!el.querySelector(PROTECTED_DESCENDANT_SELECTOR)
}
