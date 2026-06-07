"""AI taxonomy: derive a 2-level category taxonomy from a catalog and classify
products into it. Text-only Claude calls (cheap) — separate from the vision path.

Used by the competitive-coverage module: products from competitor (reference)
brands and from suppliers are classified into the same taxonomy so coverage and
gaps can be computed.
"""
from __future__ import annotations

import json
import os

from backend.services.vision import VisionNotConfigured, _parse_json, is_configured  # noqa: F401

# Taxonomy work (deriving categories + classifying products) is text-only and
# high-volume, so it defaults to the cheap model — NOT the Sonnet vision default.
# Override with TAXONOMY_MODEL if you want a different one.
DEFAULT_MODEL = os.environ.get("TAXONOMY_MODEL", "claude-haiku-4-5-20251001")

TAXONOMY_SYSTEM = (
    "You build ONE consolidated, comparable 2-level taxonomy for a home/kitchen/"
    "lifestyle catalog spanning several brands. Given many product names and the "
    "brands' own (messy, inconsistent) categories, return ONLY JSON: "
    '{"categories": [{"master": "Kitchen & Dining", "subs": ["Cookware", '
    '"Drinkware", "Tableware", "Kitchen Storage", "Cutlery"]}, ...]}.\n'
    "Rules — consolidate AGGRESSIVELY so the taxonomy is small and consistent:\n"
    "- AT MOST ~10 master categories, each with AT MOST ~8 sub-categories.\n"
    "- Merge synonyms across brands (e.g. 'Kitchen Essentials', 'Kitchenware', "
    "'Dining' → one 'Kitchen & Dining'; 'Home Decor', 'Décor & Furnishings' → "
    "'Decor & Furnishing').\n"
    "- Sub-categories must be broad product TYPES (e.g. 'Cookware', 'Storage "
    "Containers', 'Bowls', 'Bedding'), NOT individual products or one-offs.\n"
    "- Title Case, consistent naming."
)

CLASSIFY_SYSTEM = (
    "You assign each product to exactly one master category and one sub-category "
    "from the provided taxonomy. Return ONLY JSON: "
    '{"items": [{"id": <id>, "master": "Kitchen", "sub": "Cookware"}, ...]}. '
    "Pick the closest fit from the taxonomy; if nothing fits, use master "
    '"Other" and sub "Other". Every input id must appear exactly once.'
)


def _client():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise VisionNotConfigured(
            "AI isn't configured. Set ANTHROPIC_API_KEY on the server to enable "
            "classification."
        )
    import anthropic
    return anthropic.Anthropic(api_key=api_key)


def _text(message) -> str:
    return "".join(b.text for b in message.content if getattr(b, "type", None) == "text")


def suggest_taxonomy(samples: list[str], model: str | None = None) -> dict:
    """Derive a master→sub taxonomy from a sample of product names/categories."""
    client = _client()
    sample = "\n".join(f"- {s}" for s in samples[:400] if s)
    msg = client.messages.create(
        model=model or DEFAULT_MODEL, max_tokens=1500, system=TAXONOMY_SYSTEM,
        messages=[{"role": "user", "content": f"Products:\n{sample}\n\nReturn the taxonomy JSON."}],
    )
    data = _parse_json(_text(msg))
    cats = data.get("categories")
    return {"categories": cats if isinstance(cats, list) else []}


def classify_items(items: list[dict], taxonomy: dict, model: str | None = None) -> list[dict]:
    """Classify a batch of items into the taxonomy.

    ``items`` = [{"id", "name", "category"}]; returns [{"id","master","sub"}].
    """
    client = _client()
    tax = json.dumps(taxonomy.get("categories", []), ensure_ascii=False)
    lines = [{"id": it["id"], "name": it.get("name"), "category": it.get("category")} for it in items]
    msg = client.messages.create(
        model=model or DEFAULT_MODEL, max_tokens=4000, system=CLASSIFY_SYSTEM,
        messages=[{"role": "user", "content":
                   f"Taxonomy:\n{tax}\n\nProducts (JSON):\n{json.dumps(lines, ensure_ascii=False)}\n\n"
                   "Classify every product. Return the JSON."}],
    )
    data = _parse_json(_text(msg))
    out = []
    for r in data.get("items", []):
        if isinstance(r, dict) and "id" in r:
            out.append({"id": r["id"], "master_category": r.get("master"), "sub_category": r.get("sub")})
    return out
