"""Tests for the translation endpoint plumbing (no live AI calls)."""


def test_translate_config(client):
    r = client.get("/api/translate/config").json()
    assert "enabled" in r and "model" in r


def test_translate_requires_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.post("/api/translate", json={"texts": ["椅子"]})
    assert r.status_code == 400  # not configured


def test_translate_batch_limit(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    r = client.post("/api/translate", json={"texts": ["a"] * 201})
    assert r.status_code == 400  # too many in one batch
