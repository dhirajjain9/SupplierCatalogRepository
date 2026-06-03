"""AI vision extraction: read products off an image-only catalog page with Claude.

Image-based catalogs (slide/brochure PDFs) have no text layer, so the only way
to ingest them is to "look" at each page. The browser renders pages to images
and posts them here one at a time; we ask Claude to return structured products.
The API key stays server-side (never shipped to the browser).
"""
from __future__ import annotations

import base64
import json
import os

DEFAULT_MODEL = os.environ.get("VISION_MODEL", "claude-sonnet-4-6")

SYSTEM_PROMPT = (
    "You read a single page from a product catalog/brochure and return its "
    "products as strict JSON. Pages may be a cover, a section divider, or a "
    "product page showing one or more products, often bilingual (e.g. Chinese + "
    "English). Prefer the English name when both are present.\n\n"
    "Return ONLY a JSON object, no prose, with this shape:\n"
    '{"page_type": "cover|section|product|other", '
    '"supplier_name": string|null, '
    '"products": [{"name": string, "category": string|null, '
    '"specification": string|null, "color": string|null, "material": string|null, '
    '"features": string|null, "usage_scenario": string|null, '
    '"box": [x0, y0, x1, y1] | null}]}\n\n'
    "Rules: only include real products with a visible name. If the page is a "
    "cover/section/other with no products, return an empty products array. "
    "supplier_name: the company/brand if clearly shown (mainly on the cover), "
    "else null. Do not invent SKUs or prices — this catalog has none.\n"
    "box: the bounding box of THIS product's main photo, as fractions of the page "
    "from the top-left: x0,y0 = top-left corner, x1,y1 = bottom-right, each between "
    "0 and 1 (e.g. [0.05, 0.3, 0.45, 0.8]). Use null if you can't localize a photo."
)

USER_PROMPT = "Extract the products from this catalog page as JSON per the rules."


class VisionNotConfigured(RuntimeError):
    """Raised when no ANTHROPIC_API_KEY is available."""


def is_configured() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _parse_json(text: str) -> dict:
    """Pull the JSON object out of the model's reply, defensively."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1] if "```" in text[3:] else text
        text = text.lstrip("json").strip().strip("`")
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        text = text[start:end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"page_type": "other", "supplier_name": None, "products": []}
    data.setdefault("products", [])
    data.setdefault("supplier_name", None)
    data.setdefault("page_type", "product")
    if not isinstance(data["products"], list):
        data["products"] = []
    return data


def extract_products(image_bytes: bytes, media_type: str = "image/jpeg", model: str | None = None) -> dict:
    """Send one page image to Claude and return {page_type, supplier_name, products}."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise VisionNotConfigured(
            "AI extraction isn't configured. Set the ANTHROPIC_API_KEY environment "
            "variable on the server to enable image-catalog import."
        )
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    b64 = base64.standard_b64encode(image_bytes).decode("ascii")
    message = client.messages.create(
        model=model or DEFAULT_MODEL,
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                {"type": "text", "text": USER_PROMPT},
            ],
        }],
    )
    text = "".join(block.text for block in message.content if getattr(block, "type", None) == "text")
    return _parse_json(text)
