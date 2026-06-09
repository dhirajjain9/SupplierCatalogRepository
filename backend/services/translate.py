"""AI translation for non-English catalog text (mainly Chinese → English).

Catalogs from Chinese suppliers arrive with product names/specs in Chinese. The
browser collects the unique non-English strings from a parsed file and posts them
here; we ask Claude for concise English equivalents and return a {original:
english} map. The API key stays server-side.
"""
from __future__ import annotations

import json

from backend.services import ai

# Active text model (OpenAI or Claude depending on which key is set).
DEFAULT_MODEL = ai.text_model()

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
    return ai.is_configured()


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
    if not ai.is_configured():
        raise TranslateNotConfigured(
            "Translation isn't configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY on the server."
        )
    if not texts:
        return []
    text = ai.complete_text(SYSTEM_PROMPT, json.dumps(texts, ensure_ascii=False),
                            max_tokens=4096, model=model)
    out = _parse_array(text, len(texts))
    # Fall back to the original where the model dropped/short-changed an entry.
    if len(out) < len(texts):
        out = out + texts[len(out):]
    return [o or texts[i] for i, o in enumerate(out)]
