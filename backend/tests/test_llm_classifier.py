import json
from unittest.mock import MagicMock, patch

import pytest

from config import Settings
from models.common import PageBlock
from models.profile import VisualProfile
from services.llm_classifier import (
    _SYSTEM_PROMPT,
    _TEXT_PREVIEW_MAX,
    _build_user_payload,
    LLMClassificationError,
    _project_for_llm,
    classify_blocks,
)


def make_settings(**overrides):
    data = dict(featherless_api_key="test-key", featherless_model="test-model")
    data.update(overrides)
    return Settings(**data)


def make_profile():
    return VisualProfile(
        profileId="p1",
        maxVisibleBlocks=6,
        spacingMultiplier=1.2,
        textScale=1.0,
        contrastMode="standard",
        reduceMotion=False,
        progressiveReveal=False,
        simplificationStrength=0.5,
        source="manual",
    )


def make_blocks():
    # A bare <div> with no landmark and no signals classifies as Uncertain, which
    # is precisely what needs_llm_review() sends to the model.
    return [PageBlock(blockId="b1", tag="div", text="hello")]


def _mock_completion(content):
    message = MagicMock()
    message.content = content
    choice = MagicMock()
    choice.message = message
    completion = MagicMock()
    completion.choices = [choice]
    return completion


def test_missing_api_key_raises_immediately():
    settings = make_settings(featherless_api_key="")
    with pytest.raises(LLMClassificationError):
        classify_blocks(make_blocks(), make_profile(), None, settings)


@patch("services.llm_classifier.OpenAI")
def test_malformed_json_raises_llm_classification_error(mock_openai_cls):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion("not json at all")
    mock_openai_cls.return_value = mock_client

    with pytest.raises(LLMClassificationError):
        classify_blocks(make_blocks(), make_profile(), None, make_settings())


def make_ambiguous_blocks(n):
    """n bare divs - all Uncertain, so all of them go to the model."""
    return [PageBlock(blockId=f"b{i}", tag="div", text=f"block {i}") for i in range(n)]


@patch("services.llm_classifier.OpenAI")
def test_stray_out_of_range_index_is_dropped_not_fatal(mock_openai_cls):
    """One bad index costs one block, not the page: rejecting the whole response
    would throw away every correct decision alongside it."""
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion(
        '{"E": [0, 1, 2, 99], "S": [], "D": []}'
    )
    mock_openai_cls.return_value = mock_client

    result = classify_blocks(make_ambiguous_blocks(8), make_profile(), None, make_settings())
    assert [c.blockId for c in result] == ["b0", "b1", "b2"]


@patch("services.llm_classifier.OpenAI")
def test_wholesale_one_based_response_is_shifted(mock_openai_cls):
    """A model numbering from 1 is a systematic off-by-one, not noise - correcting
    it saves the page. Detected only when every index fits 1..count with no 0."""
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion('{"E": [1, 3], "S": [], "D": [4]}')
    mock_openai_cls.return_value = mock_client

    result = classify_blocks(make_ambiguous_blocks(4), make_profile(), None, make_settings())
    assert {c.blockId: c.label for c in result} == {
        "b0": "Essential",
        "b2": "Essential",
        "b3": "Distracting",
    }


@patch("services.llm_classifier.OpenAI")
def test_zero_present_prevents_one_based_shift(mock_openai_cls):
    """A response containing 0 is 0-based by definition; shifting it would
    silently relabel the wrong blocks, so the stray index is dropped instead."""
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion('{"E": [0, 1, 2, 3], "S": [], "D": []}')
    mock_openai_cls.return_value = mock_client

    result = classify_blocks(make_ambiguous_blocks(3), make_profile(), None, make_settings())
    assert [c.blockId for c in result] == ["b0", "b1", "b2"]


@patch("services.llm_classifier.OpenAI")
def test_mostly_unmappable_response_is_rejected(mock_openai_cls):
    """The tolerance is for slips. A response this far off was not answering the
    question we asked, so the rule engine takes the page."""
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion(
        '{"E": [0, 50, 60, 70], "S": [], "D": []}'
    )
    mock_openai_cls.return_value = mock_client

    with pytest.raises(LLMClassificationError):
        classify_blocks(make_ambiguous_blocks(3), make_profile(), None, make_settings())


@patch("services.llm_classifier.OpenAI")
def test_contradictory_index_keeps_first_label(mock_openai_cls):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion(
        '{"E": [0], "S": [], "D": [0, 1, 2]}'
    )
    mock_openai_cls.return_value = mock_client

    result = classify_blocks(make_ambiguous_blocks(4), make_profile(), None, make_settings())
    assert {c.blockId: c.label for c in result} == {
        "b0": "Essential",
        "b1": "Distracting",
        "b2": "Distracting",
    }


@patch("services.llm_classifier.OpenAI")
def test_empty_content_raises_llm_classification_error(mock_openai_cls):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion("")
    mock_openai_cls.return_value = mock_client

    with pytest.raises(LLMClassificationError):
        classify_blocks(make_blocks(), make_profile(), None, make_settings())


@patch("services.llm_classifier.OpenAI")
def test_valid_response_expands_indices_to_block_ids(mock_openai_cls):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion('{"E": [0], "S": [], "D": []}')
    mock_openai_cls.return_value = mock_client

    result = classify_blocks(make_blocks(), make_profile(), None, make_settings())
    assert len(result) == 1
    assert result[0].blockId == "b1"
    assert result[0].label == "Essential"


@patch("services.llm_classifier.OpenAI")
def test_empty_arrays_mean_full_agreement_with_the_rules(mock_openai_cls):
    """Omission is the default: no corrections is a valid, cheap answer, not a
    failure. Validation then fills every block from the rule engine."""
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion('{"E": [], "S": [], "D": []}')
    mock_openai_cls.return_value = mock_client

    assert classify_blocks(make_blocks(), make_profile(), None, make_settings()) == []


@patch("services.llm_classifier.OpenAI")
def test_unrequested_extra_key_is_ignored_not_rejected(mock_openai_cls):
    """A chatty model must not invalidate the response - that would dump the whole
    page onto the rule-engine fallback."""
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion(
        '{"E": [0], "S": [], "D": [], "notes": "block 0 is the article"}'
    )
    mock_openai_cls.return_value = mock_client

    result = classify_blocks(make_blocks(), make_profile(), None, make_settings())
    assert result[0].label == "Essential"


@patch("services.llm_classifier.OpenAI")
def test_confident_page_skips_the_request_entirely(mock_openai_cls):
    """No ambiguous blocks means no round-trip at all - the speedup that matters
    most on pages the rules already understand."""
    mock_openai_cls.return_value = MagicMock()
    blocks = [
        PageBlock(blockId="b1", tag="article", landmark="article", text="the story"),
        PageBlock(blockId="b2", tag="div", text="ad", isAd=True),
    ]

    assert classify_blocks(blocks, make_profile(), None, make_settings()) == []
    mock_openai_cls.return_value.chat.completions.create.assert_not_called()


@patch("services.llm_classifier.OpenAI")
def test_only_ambiguous_blocks_are_sent(mock_openai_cls):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _mock_completion('{"E": [], "S": [], "D": []}')
    mock_openai_cls.return_value = mock_client

    blocks = [
        PageBlock(blockId="decided", tag="article", landmark="article", text="the story"),
        PageBlock(blockId="ambiguous", tag="div", text="who knows"),
    ]
    classify_blocks(blocks, make_profile(), None, make_settings())

    sent = mock_client.chat.completions.create.call_args.kwargs["messages"][1]["content"]
    assert '"who knows"' in sent
    assert "the story" not in sent


def test_projection_drops_safety_flags_and_truncates_text():
    block = PageBlock(
        blockId="b1",
        tag="input",
        role="textbox",
        landmark="form",
        text="x" * 400,
        isInteractive=True,
        isPasswordField=True,
        isConsentControl=True,
        isAd=True,
        boundingBox={"x": 0.123456, "y": 0.654321, "width": 0.5, "height": 0.25},
    )

    projected = _project_for_llm(block, 3)

    assert set(projected) == {
        "i",
        "tag",
        "role",
        "elementType",
        "isInteractive",
        "textPreview",
        "provisionalLabel",
        "roughPosition",
    }
    # Indexed, not keyed on blockId: the model cannot invent an ID it never saw.
    assert projected["i"] == 3
    assert "blockId" not in projected
    assert len(projected["textPreview"]) == _TEXT_PREVIEW_MAX
    # Safety is decided server-side in validation, never by the LLM.
    assert "isSafetyCritical" not in projected
    assert "isPasswordField" not in projected
    # Coarse position only - no width/height, rounded to 2dp.
    assert projected["roughPosition"] == {"x": 0.12, "y": 0.65}


def test_projection_omits_position_when_block_has_no_bounding_box():
    projected = _project_for_llm(PageBlock(blockId="b1", tag="p", text="hi"))
    assert "roughPosition" not in projected


def test_profile_reaches_the_request_as_classification_signal():
    """The profile must be an *input to the label*, not just post-hoc layout.

    Two users differ here or they differ nowhere: this is the only place a
    profile can change what a block is classified as.
    """
    profile = make_profile()
    profile.max_visible_blocks = 6
    profile.simplification_strength = 0.85
    profile.reduce_motion = True
    profile.progressive_reveal = True
    profile.preferred_region = "left"

    payload = json.loads(_build_user_payload(make_blocks(), profile, None, False))

    assert payload["userProfile"] == {
        "attentionBudget": 6,
        "simplificationStrength": 0.85,
        "sensitiveToMotion": True,
        "readsInSections": True,
        "preferredRegion": "left",
    }
    # Rendering-only fields carry no classification meaning, so sending them
    # would imply an influence the prompt never asks the model to apply.
    assert "textScale" not in payload["userProfile"]
    assert "spacingMultiplier" not in payload["userProfile"]
    assert "contrastMode" not in payload["userProfile"]


def test_two_profiles_produce_different_requests_for_the_same_page():
    blocks = make_blocks()
    light = make_profile()
    light.simplification_strength = 0.2
    light.max_visible_blocks = 12

    heavy = make_profile()
    heavy.simplification_strength = 0.9
    heavy.max_visible_blocks = 4

    assert _build_user_payload(blocks, light, None, False) != _build_user_payload(
        blocks, heavy, None, False
    )


def test_system_prompt_tells_the_model_how_to_use_the_profile():
    """A profile in the payload the prompt never mentions is decoration."""
    for key in ("attentionBudget", "simplificationStrength", "sensitiveToMotion",
                "readsInSections", "preferredRegion"):
        assert key in _SYSTEM_PROMPT


def test_stated_task_reaches_the_request_verbatim():
    """The prompt tells the model to judge relevance against the user's task,
    so the task actually arriving is the difference between that rule meaning
    something and it being dead text."""
    payload = json.loads(
        _build_user_payload(make_blocks(), make_profile(), "the recipe, not the story", False)
    )
    assert payload["task"] == "the recipe, not the story"


def test_absent_task_falls_back_to_the_generic_browsing_task():
    payload = json.loads(_build_user_payload(make_blocks(), make_profile(), None, False))
    assert payload["task"] == "General browsing - reduce visual clutter."
