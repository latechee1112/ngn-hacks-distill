"""Step 3: validate the LLM's classifications against the request's blocks.

Any violation here means the whole LLM response is untrustworthy, so the
caller should discard it entirely and fall back to the rule engine (Step 4)
rather than try to patch a partially-bad response.
"""

from typing import Dict, List

from models.common import BlockAction, ClassificationLabel, PageBlock
from models.profile import VisualProfile
from services.llm_classifier import RawClassification
from services.rule_engine import build_action, fallback_action


class LLMValidationError(Exception):
    """Raised when the LLM's classification response is invalid or unsafe."""


_VALID_LABELS = {label.value for label in ClassificationLabel}


def validate_and_build_actions(
    classifications: List[RawClassification],
    blocks: List[PageBlock],
    profile: VisualProfile,
) -> List[BlockAction]:
    blocks_by_id: Dict[str, PageBlock] = {b.block_id: b for b in blocks}

    if len(classifications) > len(blocks):
        raise LLMValidationError("LLM returned more classifications than blocks supplied")

    seen_ids: Dict[str, str] = {}
    for c in classifications:
        if c.blockId not in blocks_by_id:
            raise LLMValidationError(f"LLM invented unknown block ID: {c.blockId}")
        if c.blockId in seen_ids and seen_ids[c.blockId] != c.label:
            raise LLMValidationError(f"Duplicate contradictory classification for block: {c.blockId}")
        # Checked here rather than left to ClassificationLabel() in the build
        # loop below: an unrecognized label is a bad LLM response, which the
        # caller handles by falling back to the rule engine - not a ValueError
        # escaping as a 500 and costing the page its analysis entirely.
        if c.label not in _VALID_LABELS:
            raise LLMValidationError(f"LLM returned unknown label for {c.blockId}: {c.label!r}")
        seen_ids[c.blockId] = c.label

    actions: List[BlockAction] = []
    classified_ids = set()

    for c in classifications:
        if c.blockId in classified_ids:
            continue  # already handled (identical duplicate) above
        classified_ids.add(c.blockId)

        block = blocks_by_id[c.blockId]

        # The LLM's label is only ever a *proposal*. build_action() is the
        # single chokepoint shared with the rule engine: it re-derives
        # Safety-critical from the block's own flags (so a password/payment/
        # consent/warning block is protected no matter what came back), and it
        # clamps the resulting action so COLLAPSE can never be emitted. Neither
        # guarantee depends on the LLM having been right.
        actions.append(build_action(block, ClassificationLabel(c.label), profile))

    # Blocks the LLM didn't mention fall back to the rule engine individually -
    # itself just another build_action() call, so they get the same guarantees.
    for block in blocks:
        if block.block_id not in classified_ids:
            actions.append(fallback_action(block, profile))

    return actions
