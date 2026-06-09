"""Provider-agnostic LLM access: OpenAI when OPENAI_API_KEY is set, else Anthropic.

Every AI feature (translation, taxonomy curate/classify, vision extraction) goes
through here, so switching providers is just an env var — set OPENAI_API_KEY to
run on OpenAI; otherwise ANTHROPIC_API_KEY is used. Model choice is per-provider:

  text  : OPENAI_TEXT_MODEL   (default gpt-4o-mini)  | TAXONOMY/TRANSLATE_MODEL (Claude)
  vision: OPENAI_VISION_MODEL (default gpt-4o-mini)  | VISION_MODEL (Claude)
"""
from __future__ import annotations

import base64
import os


class AINotConfigured(RuntimeError):
    """No AI provider key is available."""


def provider() -> str | None:
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    return None


def is_configured() -> bool:
    return provider() is not None


def text_model() -> str:
    if provider() == "openai":
        return os.environ.get("OPENAI_TEXT_MODEL", "gpt-4o-mini")
    return (os.environ.get("TAXONOMY_MODEL") or os.environ.get("TRANSLATE_MODEL")
            or "claude-haiku-4-5-20251001")


def vision_model() -> str:
    if provider() == "openai":
        return os.environ.get("OPENAI_VISION_MODEL", "gpt-4o-mini")
    return os.environ.get("VISION_MODEL", "claude-sonnet-4-6")


def _openai():
    from openai import OpenAI
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def _anthropic():
    import anthropic
    return anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def _anthropic_text(message) -> str:
    return "".join(b.text for b in message.content if getattr(b, "type", None) == "text")


def complete_text(system: str, user: str, max_tokens: int = 1024, model: str | None = None) -> str:
    """One-shot text completion via the active provider; returns the reply text."""
    p = provider()
    if p is None:
        raise AINotConfigured("No AI key configured (set OPENAI_API_KEY or ANTHROPIC_API_KEY).")
    if p == "openai":
        r = _openai().chat.completions.create(
            model=model or text_model(), max_tokens=max_tokens,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        )
        return r.choices[0].message.content or ""
    msg = _anthropic().messages.create(
        model=model or text_model(), max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": user}],
    )
    return _anthropic_text(msg)


def complete_vision(system: str, user: str, image_bytes: bytes,
                    media_type: str = "image/jpeg", max_tokens: int = 2048,
                    model: str | None = None) -> str:
    """Vision completion: one image + a text prompt, via the active provider."""
    p = provider()
    if p is None:
        raise AINotConfigured("No AI key configured (set OPENAI_API_KEY or ANTHROPIC_API_KEY).")
    b64 = base64.standard_b64encode(image_bytes).decode("ascii")
    if p == "openai":
        r = _openai().chat.completions.create(
            model=model or vision_model(), max_tokens=max_tokens,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": [
                    {"type": "text", "text": user},
                    {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{b64}"}},
                ]},
            ],
        )
        return r.choices[0].message.content or ""
    msg = _anthropic().messages.create(
        model=model or vision_model(), max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
            {"type": "text", "text": user},
        ]}],
    )
    return _anthropic_text(msg)
