// Decorative scan sweep played while the backend analysis call is in flight.
// Purely a visual overlay: it never gates, delays, or observes the
// simplification pipeline.
//
// Detection-safety is the whole design constraint here. extractPage() runs
// synchronously at the start of handleSimplify(), so this element is in the DOM
// while block detection walks it. Three things keep it out of that walk, and all
// three are load-bearing - none of the gating code knows this module exists:
//
//   1. Custom tag name, no class, no [role] - misses extract.ts's
//      CANDIDATE_SELECTOR entirely, so it is never even a candidate block.
//   2. display: contents on the host - generates no box, so
//      getBoundingClientRect() is 0x0 and isVisible() is false. That is the
//      early-out in both of collectNoiseTargets()'s passes, including the
//      `body > *` sweep that would otherwise match.
//   3. Shadow DOM - document.querySelectorAll() does not pierce the boundary,
//      so the fixed-position layers inside are unreachable from every selector
//      in extract.ts and simplify.ts.
//
// Consequence of (2): the host must stay display:contents and must never take a
// position of its own. Anything fixed/sticky lives inside the shadow root.
// The id/tag also avoid the ad/modal/popup/overlay/sidebar/consent/warning
// substrings those selectors and dom-heuristics.ts match on.

const SCAN_HOST_TAG = 'distill-scan'
const SCAN_HOST_ID = 'distill-scan-layer'

// Sites built heavily on web components (Reddit's shreddit UI among them) ship a
// hygiene rule along the lines of `:not(:defined) { visibility: hidden }`, to hide
// their OWN custom elements until the matching JS has registered and upgraded them
// (avoiding a flash of unstyled content). SCAN_HOST_TAG is a hyphenated,
// component-shaped name for the reasons above - but that also makes it match
// `:not(:defined)` on any site with that rule, since this element is never
// registered. The effect was the whole sweep silently painting with
// visibility:hidden: correct geometry, correct opacity, invisible regardless -
// confirmed live against reddit.com, where getComputedStyle(host).visibility
// flipped from 'hidden' to 'visible' the instant the tag was registered via
// customElements.define().
//
// customElements.define() looked like the fix, but window.customElements is
// null in this content script's actual execution context on reddit.com (confirmed
// from the crash's own stack trace - Chrome does not reliably expose a working
// CustomElementRegistry to every isolated world a content script runs in). So
// instead of registering the tag, :host below just overrides the inherited
// visibility directly with !important, which wins the cascade regardless of
// what rule the page applies or what order it was declared in - no dependency
// on an API that turned out to not reliably exist here.

// Three phases: INTRO plays once (grid wipes in, first beam pass). LOOP
// repeats indefinitely after that - for as long as the backend call is in
// flight, however long that turns out to be. OUTRO plays once stop() is
// called. MIN_VISIBLE_MS floors how soon stop() may start the outro, so a
// very fast response (cache hit, local fallback) can't cut the intro off
// mid-wipe.
const INTRO_MS = 560
const LOOP_MS = 900
const OUTRO_MS = 320
const MIN_VISIBLE_MS = INTRO_MS + 60
// finish() no longer reveals the page and starts fading the overlay in the same
// breath as stop() being called. Removing 'looping' lets the beam play one final
// pass (the same one-shot distill-scan-sweep it uses for the intro) and settle off
// the bottom of the viewport, faded out - HOLD_MS is the pause after that, beam
// gone and grid held steady, before the page underneath is allowed to actually
// change. Without it, the blur/removal cascade lands while the sweep is still
// visibly finishing, the same "still mid-animation" problem REVEAL_ATTR was built
// to fix, just one beat later in the sequence.
const HOLD_MS = 500

const REDUCED_INTRO_MS = 220
const REDUCED_LOOP_MS = 1100
const REDUCED_OUTRO_MS = 220
const REDUCED_MIN_VISIBLE_MS = REDUCED_INTRO_MS + 40
// Shorter than HOLD_MS: reduced motion has no beam pass to wait out (the grid just
// breathes in place), so this is a pause for the sake of legibility - "the scan is
// done, here's what changed" - not a leftover animation with nowhere else to go.
const REDUCED_HOLD_MS = 200

// Safety net, not the normal path: if stop() can never be called, the layer has
// to come down on its own. This is deliberately NOT a time limit - analysis has
// no fixed upper bound (a 100+ block page against a slow LLM legitimately runs
// for a minute), and a sweep that quits while work is still in flight tells the
// user the wrong thing. So the net checks *liveness* instead: the only way the
// caller can lose its ability to call stop() is the extension context going away
// (reload/update/uninstall), which invalidates chrome.runtime. While the context
// is alive, the sweep keeps looping for as long as the work takes.
const LIVENESS_POLL_MS = 5000

function isExtensionContextAlive(): boolean {
  try {
    return !!chrome.runtime?.id
  } catch {
    // Accessing chrome.runtime after invalidation throws rather than returning undefined.
    return false
  }
}

// Two-tier mesh: fine cells inside heavier major cells. Reads as a denser,
// more deliberate scan than a single grid at the same line weight would.
const GRID_MAJOR = 32
const GRID_MINOR = 8
const LINE_MAJOR = 'rgba(126, 182, 236, 0.55)'
const LINE_MINOR = 'rgba(126, 182, 236, 0.16)'
const WASH = 'rgba(47, 111, 181, 0.11)'
const BEAM = 'rgba(186, 222, 250, 0.98)'
const BEAM_GLOW = 'rgba(90, 158, 224, 0.55)'
const BEAM_BLOOM = 'rgba(47, 111, 181, 0.28)'
const TRAIL = 'rgba(64, 132, 200, 0.30)'
const TRAIL_HEIGHT = 160

function prefersReducedMotion(): boolean {
  // Both the OS setting and Distill's own reduce-motion state suppress the
  // sweep. This is an accessibility tool - a full-viewport moving band is
  // exactly the kind of motion the setting exists to stop.
  if (document.documentElement.hasAttribute('data-distill-reduce-motion')) return true
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

// State toggled via classes rather than baking a duration into the CSS text,
// so the same stylesheet serves the whole intro -> loop -> outro sequence -
// JS only ever adds/removes 'looping' and 'outro', never regenerates this.
const STYLE = `
:host {
  /* No box, no position - see the note at the top of this file. Belt only:
     the load-bearing copy of these declarations lives on host.style (set in
     JS below) as inline !important, since a shadow root's :host rule is just
     an ordinary-specificity author rule from the outer page's point of view
     and can lose to whatever layout rule the host site applies to its own
     children (e.g. a 'body > *' flex/grid-item rule) - which is exactly what
     let a page's flex layout swallow this element as a real column instead
     of a boxless decoration. Inline style can only be beaten by another
     inline !important, so it is the one guarantee here, not this block. */
  display: contents;
  visibility: visible !important;
}
.root {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  /* Never intercept a click. A full-viewport layer that swallowed a tap on a
     consent banner would be a real problem, not a cosmetic one. */
  pointer-events: none;
  contain: strict;
  opacity: 1;
}
.root.outro {
  animation: distill-scan-fade-out ${OUTRO_MS}ms linear forwards;
}
.root.reduced.outro {
  animation-duration: ${REDUCED_OUTRO_MS}ms;
}
.grid {
  position: absolute;
  inset: 0;
  background-color: ${WASH};
  /* Major lines painted over minor: first image in the list wins. */
  background-image:
    linear-gradient(to right, ${LINE_MAJOR} 1px, transparent 1px),
    linear-gradient(to bottom, ${LINE_MAJOR} 1px, transparent 1px),
    linear-gradient(to right, ${LINE_MINOR} 1px, transparent 1px),
    linear-gradient(to bottom, ${LINE_MINOR} 1px, transparent 1px);
  background-size:
    ${GRID_MAJOR}px ${GRID_MAJOR}px,
    ${GRID_MAJOR}px ${GRID_MAJOR}px,
    ${GRID_MINOR}px ${GRID_MINOR}px,
    ${GRID_MINOR}px ${GRID_MINOR}px;
  clip-path: inset(0 0 100% 0);
  animation: distill-scan-resolve ${INTRO_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
}
.beam {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 3px;
  background: ${BEAM};
  box-shadow: 0 0 18px 3px ${BEAM_GLOW}, 0 0 44px 12px ${BEAM_BLOOM};
  transform: translateY(-3px);
  animation: distill-scan-sweep ${INTRO_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
}
/* Body trailing the leading edge, over the region already resolved. */
.beam::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  height: ${TRAIL_HEIGHT}px;
  background: linear-gradient(to top, ${TRAIL}, transparent);
}
/* After the intro finishes, JS adds .looping - swaps the beam to an
   indefinitely repeating pass so it keeps signaling work while the request
   is still in flight. */
.root.looping .beam {
  animation: distill-scan-sweep-loop ${LOOP_MS}ms linear infinite;
}
/* prefers-reduced-motion: no positional movement. The grid fades in once and
   then breathes gently in place - no beam element at all. */
.root.reduced .grid {
  clip-path: inset(0 0 0% 0);
  opacity: 0;
  animation: distill-scan-breathe-in ${REDUCED_INTRO_MS}ms ease-out forwards;
}
.root.reduced.looping .grid {
  animation: distill-scan-breathe ${REDUCED_LOOP_MS}ms ease-in-out infinite;
}

@keyframes distill-scan-resolve {
  from { clip-path: inset(0 0 100% 0); }
  to   { clip-path: inset(0 0 0% 0); }
}
@keyframes distill-scan-sweep {
  from { transform: translateY(-3px); opacity: 1; }
  85%  { opacity: 1; }
  to   { transform: translateY(100vh); opacity: 0; }
}
@keyframes distill-scan-sweep-loop {
  0%   { transform: translateY(-3px); opacity: 1; }
  85%  { opacity: 1; }
  100% { transform: translateY(100vh); opacity: 0; }
}
@keyframes distill-scan-breathe-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes distill-scan-breathe {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1; }
}
@keyframes distill-scan-fade-out {
  from { opacity: 1; }
  to   { opacity: 0; }
}
`

// Takes down one specific host node. Deliberately by reference rather than by id:
// a restarted sweep puts a *new* node under the same id, and the outgoing
// instance's outro timer must never be able to remove its replacement.
function removeScanLayer(host: Element): void {
  host.remove()
}

// Only for hosts no closure owns any more - a layer left behind by a previous
// content-script instance on this page. The live instance is torn down through
// `activeSweep` instead, which also stops its timers.
function removeOrphanScanLayers(): void {
  document.querySelectorAll(`#${SCAN_HOST_ID}`).forEach((el) => el.remove())
}

// Immediate teardown for the sweep currently on screen, if any. A layer is not
// just a DOM node: each one owns an intro timer, a liveness interval, and
// possibly a pending outro. Removing the node alone would leave all three live in
// a closure nothing can reach.
let activeSweep: (() => void) | null = null

/**
 * Starts the scan sweep and returns a `stop` function. The sweep plays its
 * intro once, then loops indefinitely - call `stop()` when the backend
 * response (or fallback) is ready, and it plays a short outro fade before
 * removing itself. Safe to call repeatedly; an in-flight sweep is torn down
 * and restarted so one Activate press yields exactly one animation.
 *
 * "Indefinitely" is literal: the loop has no time limit and never stops itself
 * because the work is slow. It ends when the caller says the work is done, or -
 * only if the extension context dies and no caller is left to say so - when the
 * liveness check notices.
 *
 * Both starting and stopping return immediately. Callers must not await
 * `startScanAnimation()` or let it sequence work - it is decoration running
 * alongside the real analysis call, never in front of it.
 *
 * `onReveal`, if given, fires exactly once - after the beam's final pass has settled
 * and HOLD_MS has held the resolved grid on screen, right as the outro fade starts.
 * That gap is deliberate: it gives the sweep a clean, motionless moment where it
 * visibly reads as "done" before anything underneath it changes, rather than the
 * page transformation and the sweep's own finish landing in the same instant (see
 * REVEAL_ATTR in simplify.ts for why the transformation is gated on this at all).
 * Never fires on a teardown (superseded-by-restart) exit - that page is about to be
 * reprocessed by the sweep replacing this one, not shown as-is.
 */
export function startScanAnimation(onReveal?: () => void): () => void {
  if (!document.body) return () => {}

  // Restart rather than stack, so a double-press can't leave two layers running.
  // The outgoing instance is stopped through its own teardown, not by removing its
  // node: its timers have to die with it, or its outro fires later and removes the
  // layer this call is about to create.
  activeSweep?.()
  removeOrphanScanLayers()

  const reduced = prefersReducedMotion()
  const introMs = reduced ? REDUCED_INTRO_MS : INTRO_MS
  const outroMs = reduced ? REDUCED_OUTRO_MS : OUTRO_MS
  const minVisibleMs = reduced ? REDUCED_MIN_VISIBLE_MS : MIN_VISIBLE_MS
  const holdMs = reduced ? REDUCED_HOLD_MS : HOLD_MS

  const host = document.createElement(SCAN_HOST_TAG)
  host.id = SCAN_HOST_ID
  host.setAttribute('aria-hidden', 'true')
  // Load-bearing, not decoration: inline !important beats any stylesheet
  // rule the host page has, including ones that were never written with this
  // element in mind (a `body > *` flex/grid-item rule, a generic
  // `:not(:defined)` hiding rule, etc). Without this, `display: contents`
  // living only in the shadow root's `:host` block is an ordinary-specificity
  // author rule from the page's perspective and can lose that cascade - the
  // host then keeps a real box, gets laid out as a flex/grid item alongside
  // the actual content, and squeezes it into a narrow column. `position:
  // static` is set for the same reason: nothing here should ever be able to
  // give this host a position of its own.
  host.style.setProperty('display', 'contents', 'important')
  host.style.setProperty('position', 'static', 'important')
  host.style.setProperty('visibility', 'visible', 'important')

  const shadow = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = STYLE

  const root = document.createElement('div')
  root.className = reduced ? 'root reduced' : 'root'

  const grid = document.createElement('div')
  grid.className = 'grid'
  root.appendChild(grid)

  if (!reduced) {
    const beam = document.createElement('div')
    beam.className = 'beam'
    root.appendChild(beam)
  }

  shadow.append(style, root)
  document.body.appendChild(host)

  const startedAt = performance.now()
  let removed = false

  // Clears everything this instance owns except the node itself, so the two exit
  // paths below differ only in how the node goes away.
  function release(): void {
    removed = true
    if (activeSweep === teardown) activeSweep = null
    window.clearTimeout(introTimer)
    window.clearInterval(livenessTimer)
  }

  // Normal exit. Dropping 'looping' lets the beam play its final one-shot pass
  // (the same distill-scan-sweep the intro uses) and settle off-screen, faded out,
  // rather than just freezing wherever it happened to be mid-loop. holdMs then
  // holds that resolved, motionless state on screen before onReveal() and the
  // outro fire - see the note on HOLD_MS for why that pause exists at all.
  function finish(): void {
    if (removed) return
    release()
    root.classList.remove('looping')
    window.setTimeout(() => {
      onReveal?.()
      root.classList.add('outro')
      window.setTimeout(() => removeScanLayer(host), outroMs + 100)
    }, holdMs)
  }

  // Replacement exit: a new sweep is starting, so this node goes now - an outro
  // would only fade out a layer the user is no longer looking at, and its timer
  // would outlive the instance that scheduled it. Any pending finish() from a
  // stop() call in flight is neutralized by `removed`.
  function teardown(): void {
    if (removed) return
    release()
    removeScanLayer(host)
  }

  activeSweep = teardown

  // Enter the loop once the intro's own animation has actually finished
  // playing - not tied to stop(), so the loop starts even if the caller
  // takes a while to stop() it.
  const introTimer = window.setTimeout(() => {
    if (!removed) root.classList.add('looping')
  }, introMs)

  // No elapsed-time component: this tears the layer down only once nobody is left
  // who could call stop(), never because the analysis is "taking too long".
  const livenessTimer = window.setInterval(() => {
    if (!isExtensionContextAlive()) finish()
  }, LIVENESS_POLL_MS)

  let stopped = false
  return function stop(): void {
    if (stopped) return
    stopped = true
    const elapsed = performance.now() - startedAt
    const remaining = minVisibleMs - elapsed
    if (remaining > 0) {
      window.setTimeout(finish, remaining)
    } else {
      finish()
    }
  }
}
