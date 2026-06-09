"""AI taxonomy: derive a 2-level category taxonomy from a catalog and classify
products into it. Text-only Claude calls (cheap) — separate from the vision path.

Used by the competitive-coverage module: products from competitor (reference)
brands and from suppliers are classified into the same taxonomy so coverage and
gaps can be computed.
"""
from __future__ import annotations

import json

from backend.services import ai
from backend.services.vision import VisionNotConfigured, _parse_json  # noqa: F401

is_configured = ai.is_configured

# Active text model (OpenAI or Claude depending on which key is set). For Claude
# this stays the cheap Haiku default via TAXONOMY_MODEL, not the Sonnet vision one.
DEFAULT_MODEL = ai.text_model()

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


def _require_configured() -> None:
    if not ai.is_configured():
        raise VisionNotConfigured(
            "AI isn't configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY on the "
            "server to enable classification."
        )


def suggest_taxonomy(samples: list[str], model: str | None = None) -> dict:
    """Derive a master→sub taxonomy from a sample of product names/categories."""
    _require_configured()
    sample = "\n".join(f"- {s}" for s in samples[:400] if s)
    text = ai.complete_text(
        TAXONOMY_SYSTEM, f"Products:\n{sample}\n\nReturn the taxonomy JSON.",
        max_tokens=1500, model=model,
    )
    data = _parse_json(text)
    cats = data.get("categories")
    return {"categories": cats if isinstance(cats, list) else []}


def classify_items(items: list[dict], taxonomy: dict, model: str | None = None) -> list[dict]:
    """Classify a batch of items into the taxonomy.

    ``items`` = [{"id", "name", "category"}]; returns [{"id","master","sub"}].
    """
    _require_configured()
    tax = json.dumps(taxonomy.get("categories", []), ensure_ascii=False)
    lines = [{"id": it["id"], "name": it.get("name"), "category": it.get("category")} for it in items]
    text = ai.complete_text(
        CLASSIFY_SYSTEM,
        f"Taxonomy:\n{tax}\n\nProducts (JSON):\n{json.dumps(lines, ensure_ascii=False)}\n\n"
        "Classify every product. Return the JSON.",
        max_tokens=4000, model=model,
    )
    data = _parse_json(text)
    out = []
    for r in data.get("items", []):
        if isinstance(r, dict) and "id" in r:
            out.append({"id": r["id"], "master_category": r.get("master"), "sub_category": r.get("sub")})
    return out
