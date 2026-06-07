"""Tests for the optional embeddings classifier wiring.

sentence-transformers isn't installed in CI, so these assert the graceful-
fallback behaviour: config reports it off, and the endpoint 400s so the browser
falls back to the LLM classifier.
"""
from backend.services import embed_classify


def test_config_reports_embed_disabled_without_dependency(client):
    cfg = client.get("/api/taxonomy/config").json()
    assert "embed_enabled" in cfg
    # The dependency isn't installed in the test env.
    assert cfg["embed_enabled"] is False


def test_classify_embed_400_when_unavailable(client):
    r = client.post("/api/taxonomy/classify-embed", json={
        "taxonomy": {"categories": [{"master": "Kitchen", "subs": ["Cookware"]}]},
        "items": [{"id": 1, "name": "Wok", "category": None}],
    })
    assert r.status_code == 400


def test_label_flattening_pairs_master_and_subs():
    pairs, texts = embed_classify._labels(
        {"categories": [{"master": "Kitchen", "subs": ["Cookware", "Bowls"]},
                        {"master": "Decor", "subs": []}]}
    )
    assert ("Kitchen", "Cookware") in pairs
    assert ("Decor", None) in pairs          # empty subs → a master-only label
    assert "Kitchen Cookware" in texts
