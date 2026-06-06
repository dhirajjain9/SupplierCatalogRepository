"""AI translation for non-English catalog text (mainly Chinese → English).

Catalogs from Chinese suppliers arrive with product names/specs in Chinese. The
browser collects the unique non-English strings from a parsed file and posts them
here; we ask Claude for concise English equivalents and return a {original:
english} map. The API key stays server-side.
"""
from __future__ import annotations

import json
import os

DEFAULT_MODEL = os.environ.get("TRANSLATE_MODEL", "claude-haiku-4-5-20251001")

SYSTEM_PROMPT = (
    "You translate short product-catalog phrases (names, categories, materials, "
    "specifications) into concise, natural English. The input is mostly Chinese, "
    "sometimes mixed. Keep it short and catalog-appropriate — no explanations. "
    "Keep numbers, units, dimensions and model/SKU codes unchanged. If a phrase is "
    "already English, return it unchanged.\n\n"
    "You receive a JSON array of strings. Return ONLY a JSON array of the same "
    "length, in the same order, each the English translation of the input at that "
    "index. No prose, no keys — just the array."
)


class TranslateNotConfigured(RuntimeError):
    pass


def is_configured() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _parse_array(text: str, n: int) -> list[str]:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1] if "```" in text[3:] else text
        text = text.lstrip("json").strip().strip("`")
    start, end = text.find("["), text.rfind("]")
    if start != -1 and end != -1:
        text = text[start:end + 1]
    try:
        arr = json.loads(text)
    except json.JSONDecodeError:
        return []
    if not isinstance(arr, list):
        return []
    return [("" if x is None else str(x)) for x in arr][:n]


def translate(texts: list[str], model: str | None = None) -> list[str]:
    """Translate a batch of strings; returns a list aligned to the input."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise TranslateNotConfigured(
            "Translation isn't configured. Set ANTHROPIC_API_KEY on the server."
        )
    if not texts:
        return []
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model=model or DEFAULT_MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": json.dumps(texts, ensure_ascii=False)}],
    )
    text = "".join(b.text for b in message.content if getattr(b, "type", None) == "text")
    out = _parse_array(text, len(texts))
    # Fall back to the original where the model dropped/short-changed an entry.
    if len(out) < len(texts):
        out = out + texts[len(out):]
    return [o or texts[i] for i, o in enumerate(out)]
