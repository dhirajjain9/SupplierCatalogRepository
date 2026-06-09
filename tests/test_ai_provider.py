"""Tests for AI provider selection (OpenAI preferred when its key is set)."""
from backend.services import ai


def test_openai_preferred_when_key_set(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
    assert ai.provider() == "openai"
    assert ai.is_configured() is True
    assert ai.text_model() == "gpt-4o-mini"
    assert ai.vision_model() == "gpt-4o-mini"


def test_openai_model_overrides(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("OPENAI_TEXT_MODEL", "gpt-4o")
    monkeypatch.setenv("OPENAI_VISION_MODEL", "gpt-4o")
    assert ai.text_model() == "gpt-4o" and ai.vision_model() == "gpt-4o"


def test_anthropic_when_only_its_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
    assert ai.provider() == "anthropic"
    assert ai.vision_model() == "claude-sonnet-4-6"
    assert ai.text_model().startswith("claude-")


def test_unconfigured_when_no_keys(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert ai.provider() is None
    assert ai.is_configured() is False
