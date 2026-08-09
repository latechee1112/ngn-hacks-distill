def _profile(**overrides):
    base = {
        "profileId": "p1",
        "maxVisibleBlocks": 6,
        "spacingMultiplier": 1.2,
        "textScale": 1.0,
        "contrastMode": "standard",
        "reduceMotion": False,
        "progressiveReveal": False,
        "simplificationStrength": 0.7,
        "source": "manual",
    }
    base.update(overrides)
    return base


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_calibration_profile_endpoint_returns_valid_shape(client):
    resp = client.post("/v1/calibration/profile", json={"trials": []})
    assert resp.status_code == 200
    body = resp.json()
    assert "profile" in body
    assert "explanation" in body
    assert body["profile"]["source"] == "calibration"


def test_analyze_page_falls_back_without_llm_key(client):
    payload = {
        "profile": _profile(),
        "blocks": [
            {"blockId": "b1", "tag": "main", "landmark": "main", "text": "content"},
            {
                "blockId": "b2",
                "tag": "input",
                "isPasswordField": True,
                "isFormControl": True,
                "text": "pw",
            },
        ],
    }
    resp = client.post("/v1/analyze-page", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["actions"]) == 2
    b2_action = next(a for a in body["actions"] if a["blockId"] == "b2")
    assert b2_action["action"] == "keep"
    assert "fallback" in " ".join(body["warnings"]).lower()


def test_analyze_page_rejects_oversized_block_count(client):
    blocks = [{"blockId": f"b{i}", "tag": "div", "text": "x"} for i in range(151)]
    resp = client.post("/v1/analyze-page", json={"profile": _profile(), "blocks": blocks})
    assert resp.status_code == 413


def test_analyze_page_rejects_malformed_block(client):
    resp = client.post(
        "/v1/analyze-page",
        json={"profile": _profile(), "blocks": [{"unexpectedField": True}]},
    )
    assert resp.status_code == 422


def test_analyze_page_never_collapses_anything_even_at_max_strength(client):
    # Full removal (display:none) is reserved for the frontend's own local,
    # high-confidence ad/tracker detection - the backend's classification
    # can only dim content, at any strength, since a wrong dim is
    # recoverable by eye and a wrong disappearance is not.
    payload = {
        "profile": _profile(simplificationStrength=1.0),
        "blocks": [
            {"blockId": "b1", "tag": "div", "isWarning": True, "text": "Payment failed"},
            {"blockId": "b2", "tag": "div", "isAd": True, "text": "Buy now"},
        ],
    }
    resp = client.post("/v1/analyze-page", json=payload)
    assert resp.status_code == 200
    actions = {a["blockId"]: a["action"] for a in resp.json()["actions"]}
    assert actions["b1"] != "collapse"
    assert actions["b2"] != "collapse"


def test_over_length_tag_is_truncated_not_rejected():
    """One web-component tag must not cost the whole page its analysis.

    Regression: YouTube renders <yt-thumbnail-bottom-overlay-view-model> (38
    chars). Against the old 32-char cap that 422'd the entire request, so every
    other block on the page was lost with it.
    """
    from models.common import PageBlock

    block = PageBlock(
        blockId="ff-1",
        tag="yt-thumbnail-bottom-overlay-view-model",
        role="x" * 200,
        landmark="y" * 200,
        text="z" * 5000,
    )

    assert block.tag == "yt-thumbnail-bottom-overlay-view-model"
    assert len(block.role) == 64
    assert len(block.landmark) == 32
    assert len(block.text) == 2000


def test_extremely_long_tag_is_clamped_to_the_field_bound():
    from models.common import PageBlock

    block = PageBlock(blockId="ff-1", tag="custom-element-" + "x" * 500)
    assert len(block.tag) == 64


def test_analyze_page_accepts_a_stated_task(client):
    resp = client.post(
        "/v1/analyze-page",
        json={
            "profile": _profile(),
            "task": "the recipe, not the story",
            "blocks": [{"blockId": "b1", "tag": "main", "landmark": "main", "text": "content"}],
        },
    )
    assert resp.status_code == 200


def test_analyze_page_rejects_an_over_length_task(client):
    """The frontend caps the task at 300 in two places (the input's maxLength and
    content.ts's slice) precisely because going over costs the page its whole
    analysis, not just the task - this is the behaviour those caps defend against."""
    resp = client.post(
        "/v1/analyze-page",
        json={
            "profile": _profile(),
            "task": "x" * 301,
            "blocks": [{"blockId": "b1", "tag": "main", "landmark": "main", "text": "content"}],
        },
    )
    assert resp.status_code == 422


def test_analyze_page_accepts_a_passively_derived_profile(client):
    resp = client.post(
        "/v1/analyze-page",
        json={
            "profile": _profile(source="usage"),
            "blocks": [{"blockId": "b1", "tag": "main", "landmark": "main", "text": "content"}],
        },
    )
    assert resp.status_code == 200
