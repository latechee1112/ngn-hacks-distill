from models.common import PageBlock
from models.common import ClassificationLabel
from models.profile import VisualProfile
from services import rule_engine


def make_profile(simplification_strength=0.7):
    return VisualProfile(
        profileId="p1",
        maxVisibleBlocks=6,
        spacingMultiplier=1.2,
        textScale=1.0,
        contrastMode="standard",
        reduceMotion=False,
        progressiveReveal=False,
        simplificationStrength=simplification_strength,
        source="manual",
    )


def make_block(**kwargs):
    defaults = dict(blockId="b1", tag="div", text="")
    defaults.update(kwargs)
    return PageBlock(**defaults)


def test_password_field_is_safety_critical():
    block = make_block(tag="input", isPasswordField=True, isFormControl=True)
    assert rule_engine.classify_block(block) == ClassificationLabel.SAFETY_CRITICAL


def test_safety_critical_action_is_always_keep():
    block = make_block(tag="input", isPasswordField=True, isFormControl=True)
    profile = make_profile(simplification_strength=1.0)
    action = rule_engine.fallback_action(block, profile)
    assert action.action.value == "keep"
    assert action.priority == 1


def test_warning_block_never_collapsed_even_at_max_simplification():
    block = make_block(tag="div", isWarning=True)
    profile = make_profile(simplification_strength=1.0)
    action = rule_engine.fallback_action(block, profile)
    assert action.action.value != "collapse"


def test_main_landmark_is_essential():
    block = make_block(tag="div", landmark="main")
    assert rule_engine.classify_block(block) == ClassificationLabel.ESSENTIAL


def test_distracting_block_is_deemphasized_even_at_high_simplification_strength():
    # Distracting content is dimmed, never fully removed, regardless of
    # strength - full removal is reserved for the frontend's own local ad
    # detection, never this classification (see action_for_category).
    block = make_block(tag="nav", landmark="nav")
    profile = make_profile(simplification_strength=0.8)
    action = rule_engine.fallback_action(block, profile)
    assert action.action.value == "deemphasize"


def test_distracting_block_is_deemphasized_at_low_simplification_strength():
    block = make_block(tag="nav", landmark="nav")
    profile = make_profile(simplification_strength=0.2)
    action = rule_engine.fallback_action(block, profile)
    assert action.action.value == "deemphasize"


def test_visible_form_control_never_collapsed_even_if_in_nav():
    block = make_block(tag="button", isInteractive=True, isFormControl=True, landmark="nav")
    profile = make_profile(simplification_strength=1.0)
    action = rule_engine.fallback_action(block, profile)
    assert action.action.value != "collapse"


def test_form_instruction_never_collapsed():
    block = make_block(tag="div", isFormInstruction=True, landmark="nav")
    profile = make_profile(simplification_strength=1.0)
    action = rule_engine.fallback_action(block, profile)
    assert action.action.value != "collapse"


def test_rule_engine_fallback_produces_action_for_every_block():
    blocks = [make_block(blockId=f"b{i}", tag="div") for i in range(5)]
    profile = make_profile()
    actions = rule_engine.fallback_actions(blocks, profile)
    assert len(actions) == 5
    assert {a.block_id for a in actions} == {b.block_id for b in blocks}


def test_reason_varies_by_seed_but_is_stable_per_seed():
    """Same block always reads the same; different blocks of one category
    don't all read identically. crc32 (not hash()) keeps it stable across runs."""
    category = ClassificationLabel.DISTRACTING

    assert rule_engine.reason_for_category(category, "ff-1") == rule_engine.reason_for_category(category, "ff-1")

    seen = {rule_engine.reason_for_category(category, f"ff-{i}") for i in range(30)}
    assert len(seen) > 1

    valid = set(rule_engine._REASONS_BY_CATEGORY[category])
    assert seen <= valid


def test_reason_without_seed_is_deterministic_first_variant():
    for category in ClassificationLabel:
        assert rule_engine.reason_for_category(category) == rule_engine._REASONS_BY_CATEGORY[category][0]


def test_every_category_has_multiple_phrasings():
    for category in ClassificationLabel:
        assert len(rule_engine._REASONS_BY_CATEGORY[category]) >= 2


# --- The protection contract, asserted structurally --------------------------
# These do not spot-check example blocks. They enumerate every label the
# classifiers can propose against every safety flag the model defines, so a
# future edit to action_for_category() (the obvious one being "collapse
# Distracting content once simplification_strength is high enough") fails here
# rather than shipping. build_action() is the single chokepoint both the rule
# engine and the LLM path go through - see its docstring.

SAFETY_FLAGS = ["isPasswordField", "isPaymentField", "isConsentControl", "isWarning"]


def test_action_for_category_never_returns_collapse():
    """Asserts the invariant UPSTREAM of build_action()'s clamp.

    build_action() clamps COLLAPSE to a dim, which is right for production but
    means test_no_label_can_ever_produce_collapse below would keep passing even
    after someone wired collapse into action_for_category() - the clamp would
    quietly absorb it and only a log line would tell anyone. Verified: injecting
    `if profile.simplification_strength >= 0.9: return ActionType.COLLAPSE`
    there leaves every other test in this suite green and fails only this one.
    """
    for strength in (0.0, 0.5, 0.9, 1.0):
        profile = make_profile(simplification_strength=strength)
        for category in ClassificationLabel:
            for tag in ("div", "nav", "aside", "footer", "input", "iframe"):
                action = rule_engine.action_for_category(category, make_block(tag=tag), profile)
                assert action.value != "collapse", (
                    f"action_for_category returned COLLAPSE for {category} / {tag} @ {strength}"
                )


def test_no_label_can_ever_produce_collapse():
    """No (label x strength x block shape) combination may emit COLLAPSE."""
    for strength in (0.0, 0.5, 1.0):
        profile = make_profile(simplification_strength=strength)
        for proposed in ClassificationLabel:
            for tag in ("div", "nav", "aside", "footer", "input", "iframe"):
                for flag in [None, *SAFETY_FLAGS]:
                    kwargs = {"tag": tag} if flag is None else {"tag": tag, flag: True}
                    action = rule_engine.build_action(make_block(**kwargs), proposed, profile)
                    assert action.action.value != "collapse", (
                        f"collapse emitted for {proposed} / {tag} / {flag} @ {strength}"
                    )


def test_safety_critical_block_survives_any_proposed_label():
    """Every safety flag forces Safety-critical + keep, whatever was proposed.

    This is the LLM-can't-override-us guarantee: `proposed` here stands in for
    whatever label came back from the model, including Distracting.
    """
    profile = make_profile(simplification_strength=1.0)
    for flag in SAFETY_FLAGS:
        for proposed in ClassificationLabel:
            block = make_block(tag="div", **{flag: True})
            assert rule_engine.resolve_label(block, proposed) == ClassificationLabel.SAFETY_CRITICAL
            action = rule_engine.build_action(block, proposed, profile)
            assert action.action.value == "keep", f"{flag} + {proposed} was not kept"
            assert action.priority == 1


def test_build_action_is_the_only_blockaction_constructor():
    """Guards the claim itself: one chokepoint, not one-per-classifier.

    If a third construction site appears, the guarantees above stop covering
    the whole backend and this fails - which is the point.
    """
    import pathlib
    import re

    services = pathlib.Path(__file__).resolve().parent.parent / "services"
    sites = [
        f"{path.name}:{i}"
        for path in sorted(services.glob("*.py"))
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if re.search(r"\bBlockAction\(", line)
    ]
    assert len(sites) == 1, f"BlockAction must be constructed only in build_action(); found {sites}"
    assert sites[0].startswith("rule_engine.py:"), f"unexpected construction site: {sites[0]}"
