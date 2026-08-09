"""Step 1 (rule-based classification) and Step 4 (LLM fallback).

Pure, deterministic functions - no network calls, no LLM. This is the
safety net: it always produces a valid result, so the API can degrade to
it whenever the LLM is unavailable or returns something invalid.

build_action() at the bottom of this file is the ONE function that turns a
proposed label into a BlockAction, and it is the only place in the backend
that constructs one. Both classifiers - these rules and the LLM path in
services.validation - go through it, so the protection contract below is a
property of the code's shape rather than of either classifier's accuracy.
"""

import logging
from zlib import crc32

from models.common import ActionType, BlockAction, ClassificationLabel, PageBlock
from models.profile import VisualProfile

logger = logging.getLogger("focusfit.rule_engine")

_MAIN_LANDMARKS = {"main", "article"}
_LOW_RELEVANCE_LANDMARKS = {"nav", "aside", "footer"}
_LOW_RELEVANCE_TAGS = {"nav", "aside", "footer"}

_PRIORITY_BY_CATEGORY = {
    ClassificationLabel.SAFETY_CRITICAL: 1,
    ClassificationLabel.ESSENTIAL: 2,
    ClassificationLabel.SUPPORTING: 5,
    ClassificationLabel.UNCERTAIN: 5,
    ClassificationLabel.DISTRACTING: 8,
}


def resolve_label(block: PageBlock, proposed: ClassificationLabel) -> ClassificationLabel:
    """The single place a *proposed* label becomes a *final* one.

    Safety-critical is never anyone's opinion - not the rules', not the LLM's.
    It is re-derived here from the block's own flags (is_safety_critical(): a
    password field, a payment field, a consent control, a warning) and
    overrides whatever was proposed. Both classifiers reach this through
    build_action(), so neither can route around it.
    """
    if block.is_safety_critical():
        return ClassificationLabel.SAFETY_CRITICAL
    return proposed


def _classify_by_rules(block: PageBlock) -> ClassificationLabel:
    """The rules' *proposal* only - the safety override lives in resolve_label()."""

    if block.is_form_instruction:
        return ClassificationLabel.SUPPORTING

    landmark = (block.landmark or "").lower()
    tag = (block.tag or "").lower()

    # Explicit ad/promo/autoplay/repeated-link signals must win over the
    # landmark check below: the frontend now resolves `landmark` from the
    # nearest ancestor main/article (see extract.ts's landmarkOf), not just
    # the element's own tag, so an in-content ad or promo card sitting
    # inside <article> would otherwise inherit "main landmark -> Essential"
    # and never reach this check at all.
    if block.is_ad or block.is_sticky_promo or block.is_autoplay_media or block.is_repeated_link:
        return ClassificationLabel.DISTRACTING

    if landmark in _MAIN_LANDMARKS:
        return ClassificationLabel.ESSENTIAL

    if tag.startswith("h") and tag[1:].isdigit() and landmark in _MAIN_LANDMARKS | {""}:
        return ClassificationLabel.SUPPORTING

    if landmark in _LOW_RELEVANCE_LANDMARKS or tag in _LOW_RELEVANCE_TAGS:
        return ClassificationLabel.DISTRACTING

    if block.is_interactive or block.is_form_control:
        return ClassificationLabel.SUPPORTING

    return ClassificationLabel.UNCERTAIN


def classify_block(block: PageBlock) -> ClassificationLabel:
    """Step 1: obvious rules, applied before any LLM call.

    Still returns Safety-critical for a safety-critical block, exactly as
    before - but via resolve_label() rather than its own copy of the check,
    so there is one implementation of that rule in the codebase.
    """
    return resolve_label(block, _classify_by_rules(block))


def needs_llm_review(block: PageBlock) -> bool:
    """Whether this block's rule classification is a guess worth spending tokens on.

    Latency is linear in how many blocks the LLM has to emit a decision for, so
    the cheapest speedup available is to not ask about blocks the rules already
    decide confidently. Two cases are genuinely uncertain:

      - UNCERTAIN itself: the rules found no signal at all.
      - DISTRACTING inferred purely from a landmark/tag (nav, aside, footer).
        That is a guess about page furniture, and it is wrong exactly when a
        site puts real content in an <aside> - the case where a model's reading
        of the text earns its keep.

    Everything else is skipped: safety-critical and ad/promo/autoplay/repeated-link
    are hard signals, main/article is the safe direction, and a Supporting block
    is kept either way so the label cannot change the outcome. is_repeated_link in
    particular stays a hard signal for latency (see llm_classifier.py's decode-cost
    note) - false positives on inline "further reading" callouts (e.g. AccuWeather's
    "[More coverage: A | B]") are handled per-site in the frontend's siteRules.ts
    instead of paying an LLM round-trip on every page with a dense link cluster.
    """
    if block.is_safety_critical():
        return False

    category = classify_block(block)
    if category == ClassificationLabel.UNCERTAIN:
        return True
    if category == ClassificationLabel.DISTRACTING:
        return not (
            block.is_ad
            or block.is_sticky_promo
            or block.is_autoplay_media
            or block.is_repeated_link
        )
    return False


def action_for_category(
    category: ClassificationLabel, block: PageBlock, profile: VisualProfile
) -> ActionType:
    if category == ClassificationLabel.ESSENTIAL:
        return ActionType.EMPHASIZE

    if category in (
        ClassificationLabel.SAFETY_CRITICAL,
        ClassificationLabel.SUPPORTING,
        ClassificationLabel.UNCERTAIN,
    ):
        return ActionType.KEEP

    # Distracting content is always dimmed, never fully removed - full removal
    # (display:none, ActionType.COLLAPSE) is reserved for the frontend's own
    # local, high-confidence ad/tracker detection (hideAds() in simplify.ts),
    # never for this classification. A dim is safe to be wrong about; a
    # block disappearing outright is not, and this classification can be
    # wrong - e.g. a plain post image once got flagged Distracting purely
    # because its own class name happened to contain the substring
    # "lightbox" (Reddit's naming for "clicking this opens a lightbox
    # viewer", not the image being a popup - see dom-heuristics.ts's
    # isPopupLike). profile.simplification_strength still controls how
    # strongly deemphasized content is visually dimmed (see
    # setBlurIntensity() in simplify.ts), just not whether it disappears.
    return ActionType.DEEMPHASIZE


_REASONS_BY_CATEGORY = {
    ClassificationLabel.SAFETY_CRITICAL: (
        "Safety-critical content",
        "Protected: security or consent content",
        "Kept intact - safety-relevant",
    ),
    ClassificationLabel.ESSENTIAL: (
        "Primary page content",
        "Core content for this page",
        "Main reading content",
    ),
    ClassificationLabel.SUPPORTING: (
        "Supporting content",
        "Secondary content, kept visible",
        "Supports the main content",
    ),
    ClassificationLabel.UNCERTAIN: (
        "Uncertain relevance, kept conservatively",
        "Relevance unclear - left untouched",
        "Ambiguous content, kept to be safe",
    ),
    ClassificationLabel.DISTRACTING: (
        "Low-relevance or distracting content",
        "Peripheral content, de-emphasized",
        "Not relevant to the main content",
    ),
}


def reason_for_category(category: ClassificationLabel, seed: str = "") -> str:
    """Explainability text for a classified block.

    The LLM no longer generates per-block reasons - asking for a free-text
    reason on every block dominated decode time, and decode is sequential.
    These are canned instead. `seed` (pass the block ID) picks between
    phrasings so a page full of one category doesn't read as copy-paste;
    it is hashed with crc32 rather than hash() because str hashing is
    salted per process and would make the same page produce different
    text on every run.
    """
    variants = _REASONS_BY_CATEGORY[category]
    if not seed:
        return variants[0]
    return variants[crc32(seed.encode("utf-8")) % len(variants)]


def build_action(
    block: PageBlock, proposed: ClassificationLabel, profile: VisualProfile
) -> BlockAction:
    """The only place in the backend that constructs a BlockAction.

    Every classification - rule-derived or LLM-derived - is funnelled through
    here, which is what makes the protection contract structural rather than
    statistical. Two things are enforced, in this order:

      1. resolve_label() re-derives Safety-critical from the block's own
         flags, overriding whatever was proposed.
      2. The resulting action is clamped so COLLAPSE (display:none) can never
         leave this function, whatever action_for_category() decides and
         whatever simplification_strength the profile carries.

    The clamp is deliberately fail-safe rather than fail-loud: this is an
    accessibility aid, so a future edit that wires collapse into
    action_for_category() should degrade to a dimmed page and a loud log line,
    not a 500 that leaves the user with no simplification at all. The log line
    is the signal; test_no_label_can_ever_produce_collapse is what should
    actually catch it, before it ships.
    """
    label = resolve_label(block, proposed)
    action = action_for_category(label, block, profile)

    if action is ActionType.COLLAPSE:
        logger.error(
            "block_id=%s label=%s action_for_category returned COLLAPSE - the backend's "
            "classification must never fully remove content. Clamping.",
            block.block_id,
            label.value,
        )
        action = (
            ActionType.KEEP
            if label is ClassificationLabel.SAFETY_CRITICAL
            else ActionType.DEEMPHASIZE
        )

    return BlockAction(
        blockId=block.block_id,
        action=action,
        priority=_PRIORITY_BY_CATEGORY[label],
        # Seeded on block ID so same-label blocks on one page don't all read
        # identically, and so the same page produces the same text every run.
        reason=reason_for_category(label, block.block_id)[:200],
    )


def fallback_action(block: PageBlock, profile: VisualProfile) -> BlockAction:
    """Step 4: full rule-only action for a single block."""
    return build_action(block, _classify_by_rules(block), profile)


def fallback_actions(blocks: list[PageBlock], profile: VisualProfile) -> list:
    return [fallback_action(block, profile) for block in blocks]
