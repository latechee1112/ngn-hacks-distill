"""Step 2: LLM classification of page blocks (Featherless AI, OpenAI-compatible API).

The LLM only ever sees sanitized block metadata and only ever returns a
label per block ID - never HTML, never executable code, never a rewritten
page. Its raw output is untrusted until services.validation checks it.
"""

import json
import logging
from typing import List, Optional

from openai import APIError, APITimeoutError, OpenAI
from pydantic import BaseModel, ValidationError

from config import Settings
from models.common import ClassificationLabel, PageBlock
from models.profile import VisualProfile
from services import rule_engine

logger = logging.getLogger("focusfit.llm_classifier")

# Output format note: the response repeats no block IDs and no label names, only
# indices. Decode is sequential and dominates latency here - the old
# {"blockId": "ff-12", "label": "Distracting"} entry cost ~20 tokens to express a
# decision worth about two bits, so a 60-block page spent ~1300 output tokens and
# ~30s almost entirely on restating its own input. Indices into the list the model
# was just given cost 1-3 tokens each, and anything the model does not mention
# keeps the rule engine's label - so a page it fully agrees with costs almost
# nothing to answer.
_SYSTEM_PROMPT = """You are a page-simplification classifier for an accessibility tool called \
FocusFit. You will be given a JSON list of sanitized webpage blocks, each with an index "i". \
Each block already has a provisional label from a rule engine. Your job is to correct the \
ones the rules got wrong.

Rules you MUST follow:
- Respond with JSON only, in exactly this shape: {"E": [], "S": [], "D": []}
- "E" = Essential, "S" = Supporting, "D" = Distracting. List the index "i" of each block \
whose correct label differs from its provisionalLabel.
- Indices are 0-based exactly as given in "i": the first block is 0 and the last is one less \
than the number of blocks. Never emit an index equal to the number of blocks.
- Omit any block whose provisional label is already right. Omitting is the default - if you \
agree with everything, respond {"E": [], "S": [], "D": []}.
- Use only indices that appear in the input. Never invent an index. Never list the same index \
in more than one array.
- Output nothing but that JSON object: no labels, no block text, no reasons, no explanation.
- Never output HTML, JavaScript, CSS, or any executable code.
- Never rewrite or repeat webpage content.
- Judge relevance to the user's stated task. Content the user came to read is E. Navigation, \
ads, related-links, promos and page furniture are D. Anything supporting the main content \
without being it is S.
- If pageHasSensitiveForms is true, be conservative with form/input blocks - prefer S over D.
- When genuinely unsure, omit the block rather than guessing - this is an accessibility aid, \
so err conservative.

The request carries a "userProfile" describing how THIS reader actually reads, measured from \
a calibration session or from their browsing. Two people can correctly get different answers \
for the same page. Apply it:
- attentionBudget is roughly how many blocks this reader can hold at once. Mark at most that \
many blocks E; if more compete, keep only the strongest as E and make the rest S.
- simplificationStrength is 0-1. At 0.7 or above, a borderline block goes D. At 0.3 or below, \
a borderline block stays S. In between, omit it.
- sensitiveToMotion true: carousels, autoplaying or animated media, and tickers go D even \
when they sit inside the main content.
- readsInSections true: this reader is shown one section at a time, so be stricter about E - \
prefer a small number of clearly-primary blocks.
- preferredRegion names the side of the page this reader's attention favours (roughPosition.x \
below 0.33 is left, above 0.66 is right). A block on the opposite side needs to be clearly \
primary content to be E; otherwise prefer S or D.
"""

# Maps the response keys to real labels. Safety-critical is deliberately absent:
# it is re-derived server-side in validation from the block's own flags and is
# never the LLM's call. Uncertain is absent because omission already means it.
_LABEL_BY_KEY = {
    "E": ClassificationLabel.ESSENTIAL.value,
    "S": ClassificationLabel.SUPPORTING.value,
    "D": ClassificationLabel.DISTRACTING.value,
}

# Ceiling on the response. The compact format means even a page where every block
# is corrected fits well inside this; it exists so a model that ignores the format
# and starts narrating cannot stall the request until the timeout.
_MAX_RESPONSE_TOKENS = 1024

# The rule engine is already the fallback for any failure, so a retry only turns
# one slow request into three. Fail fast and let the caller degrade.
_MAX_RETRIES = 0

# Hard cap on the text sent per block. The classifier only needs enough to
# recognize what a block is, not to read it.
_TEXT_PREVIEW_MAX = 100


class LLMClassificationError(Exception):
    """Raised whenever the LLM call fails or returns something unusable.

    Callers must catch this and fall back to the rule engine (Step 4) -
    it must never surface as a 500 to the client.
    """


class RawClassification(BaseModel):
    # "ignore", not "forbid": the prompt no longer asks for a reason, but a
    # chatty model that emits one anyway must not invalidate the whole
    # response and dump the page onto the rule-engine fallback. Unknown keys
    # are dropped; only blockId and label are ever read.
    model_config = {"extra": "ignore"}

    blockId: str
    label: str


class RawClassificationResponse(BaseModel):
    """The wire shape: three index lists, nothing else.

    Field names are the single letters the model is asked for; `extra: ignore`
    keeps a model that adds a fourth key from invalidating the whole response.
    """

    model_config = {"extra": "ignore"}

    E: List[int] = []
    S: List[int] = []
    D: List[int] = []


def _project_for_llm(block: PageBlock, index: int = 0) -> dict:
    """Request-time projection of a PageBlock down to classification signal only.

    Deliberately not a change to PageBlock itself - the full model is still
    what the rule engine, validation, and action-building all see. This is
    only the shape that crosses the wire to the LLM.

    Safety flags are excluded on purpose: they are never LLM-decided.
    validation.validate_and_build_actions() re-derives Safety-critical from
    block.is_safety_critical() and overrides whatever label came back, so
    sending them would only spend tokens on a decision already made here.
    """
    projected = {
        # Position in the list sent to the model. Replaces blockId: the response
        # refers to blocks by index, which is both cheaper to emit and impossible
        # to hallucinate into an ID that was never sent.
        "i": index,
        "tag": block.tag,
        "role": block.role,
        "elementType": block.landmark,
        "isInteractive": block.is_interactive,
        "textPreview": block.text[:_TEXT_PREVIEW_MAX],
        # What the rules already decided. The model only has to say where it
        # disagrees, so agreement costs no output tokens at all.
        "provisionalLabel": rule_engine.classify_block(block).value,
    }
    if block.bounding_box is not None:
        # Coarse placement only - 2dp of viewport fraction is enough to tell
        # "top strip" from "main column" without shipping four full floats.
        projected["roughPosition"] = {
            "x": round(block.bounding_box.x, 2),
            "y": round(block.bounding_box.y, 2),
        }
    return projected


def _project_profile_for_llm(profile: VisualProfile) -> dict:
    """The profile as classification signal, renamed to what it means.

    Only the fields that can legitimately change a *label* are sent. text_scale,
    spacing_multiplier and contrast_mode are deliberately excluded: they change
    how a kept block is rendered, not whether it is worth keeping, so feeding
    them here would spend tokens implying an influence they do not have.

    The renaming is not cosmetic - "maxVisibleBlocks" reads as a layout cap the
    model cannot act on, while "attentionBudget" states the thing the prompt
    actually asks it to ration.
    """
    return {
        "attentionBudget": profile.max_visible_blocks,
        "simplificationStrength": profile.simplification_strength,
        "sensitiveToMotion": profile.reduce_motion,
        "readsInSections": profile.progressive_reveal,
        "preferredRegion": profile.preferred_region,
    }


def _build_user_payload(
    blocks: List[PageBlock],
    profile: VisualProfile,
    task: Optional[str],
    has_sensitive_forms: bool,
) -> str:
    sanitized = [_project_for_llm(b, i) for i, b in enumerate(blocks)]
    payload = {
        "task": task or "General browsing - reduce visual clutter.",
        "userProfile": _project_profile_for_llm(profile),
        "pageHasSensitiveForms": has_sensitive_forms,
        "blocks": sanitized,
    }
    return json.dumps(payload, separators=(",", ":"))


def classify_blocks(
    blocks: List[PageBlock],
    profile: VisualProfile,
    task: Optional[str],
    settings: Settings,
    has_sensitive_forms: bool = False,
) -> List[RawClassification]:
    if not settings.featherless_api_key:
        raise LLMClassificationError("No LLM API key configured")

    # Only the blocks whose rule classification is a genuine guess are worth a
    # round-trip. Everything else keeps its rule label, which is what an omitted
    # block gets anyway - so skipping them changes no outcome, only cost.
    reviewed = [b for b in blocks if rule_engine.needs_llm_review(b)]
    if not reviewed:
        # The rules were confident about the whole page. No request, no latency;
        # validation fills every block from the rule engine as usual.
        logger.info("No ambiguous blocks to review - skipping LLM call")
        return []

    client = OpenAI(
        api_key=settings.featherless_api_key,
        base_url=settings.featherless_base_url,
        timeout=settings.llm_timeout_seconds,
        max_retries=_MAX_RETRIES,
    )

    try:
        completion = client.chat.completions.create(
            model=settings.featherless_model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": _build_user_payload(reviewed, profile, task, has_sensitive_forms),
                },
            ],
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=_MAX_RESPONSE_TOKENS,
        )
    except (APIError, APITimeoutError) as exc:
        raise LLMClassificationError(f"LLM request failed: {exc}") from exc

    content = completion.choices[0].message.content if completion.choices else None
    if not content:
        raise LLMClassificationError("LLM returned empty content")

    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise LLMClassificationError(f"LLM did not return valid JSON: {exc}") from exc

    try:
        parsed = RawClassificationResponse.model_validate(raw)
    except ValidationError as exc:
        raise LLMClassificationError(f"LLM JSON failed schema validation: {exc}") from exc

    return _expand(parsed, reviewed)


# Share of returned indices that may be unusable before the response as a whole is
# treated as untrustworthy. A stray index is a slip; a response that is mostly
# unmappable means the model was not answering the question we asked, and the rule
# engine should handle the page instead.
_MAX_UNUSABLE_INDEX_RATIO = 0.25


def _looks_one_based(indices: List[int], count: int) -> bool:
    """Whether the model numbered from 1 despite being given 0-based indices.

    Worth detecting rather than discarding: it is a systematic off-by-one, not
    noise, and it is only safe to correct when the evidence covers the whole
    response - every index inside 1..count, and never a 0. A response mixing 0
    with an out-of-range index is something else and must not be shifted, since
    shifting it would silently relabel the wrong blocks.
    """
    if not indices:
        return False
    return min(indices) >= 1 and max(indices) == count


def _expand(parsed: RawClassificationResponse, reviewed: List[PageBlock]) -> List[RawClassification]:
    """Turns the index lists back into the {blockId, label} pairs validation expects.

    This is the boundary where the compact wire format ends: everything
    downstream (validation, safety overrides, action building) still works on
    explicit per-block labels and is untouched by the format change.

    Blocks simply not mentioned are the normal case - they keep their rule label,
    because validation falls back per-block for anything absent here.
    """
    count = len(reviewed)
    groups = [(getattr(parsed, key), label) for key, label in _LABEL_BY_KEY.items()]
    all_indices = [i for indices, _ in groups for i in indices]

    offset = 0
    if _looks_one_based(all_indices, count):
        logger.info("LLM answered with 1-based indices; shifting to match the 0-based input")
        offset = -1

    classifications: List[RawClassification] = []
    claimed: dict[int, str] = {}
    unusable = 0

    for indices, label in groups:
        for raw_index in indices:
            index = raw_index + offset
            # One bad index costs one block, not the page. Rejecting the whole
            # response here would throw away every correct decision alongside it.
            if not 0 <= index < count:
                logger.warning("Ignoring out-of-range block index %s (sent %s blocks)", raw_index, count)
                unusable += 1
                continue
            if index in claimed:
                if claimed[index] != label:
                    logger.warning("Ignoring contradictory second label for block index %s", index)
                    unusable += 1
                continue
            claimed[index] = label
            classifications.append(
                RawClassification(blockId=reviewed[index].block_id, label=label)
            )

    if all_indices and unusable / len(all_indices) > _MAX_UNUSABLE_INDEX_RATIO:
        raise LLMClassificationError(
            f"LLM response was mostly unmappable: {unusable} of {len(all_indices)} indices unusable"
        )

    return classifications
