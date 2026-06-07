"""Optional zero-cost product classifier using local sentence embeddings.

When ``sentence-transformers`` is installed, products can be filed into the
taxonomy by nearest-neighbour in embedding space — no LLM, no API credits, no
rate limits. This is meant for a self-hosted deployment: the dependency (torch +
model weights) is far too big for Vercel's serverless bundle, so it is NOT in
requirements.txt. Install it explicitly to turn this on:

    pip install -r requirements-embed.txt
    EMBED_CLASSIFY=1   # (optional; auto-on once the package is importable)

A multilingual model (default ``intfloat/multilingual-e5-small``) handles the
Chinese supplier names. The Claude classifier remains the fallback when this
isn't available.
"""
from __future__ import annotations

import os

# e5-family models are trained with "query:"/"passage:" prefixes; using them
# meaningfully improves short-text matching. Override the model via EMBED_MODEL.
_MODEL_NAME = os.environ.get("EMBED_MODEL", "intfloat/multilingual-e5-small")
# Items whose best label similarity is below this are sent to "Other" rather than
# force-fit. 0 disables the floor (always pick the nearest). Tune per model.
_MIN_SIM = float(os.environ.get("EMBED_MIN_SIM", "0") or 0)

_model = None


def is_available() -> bool:
    """True if embeddings classification can run (package present & not disabled)."""
    if os.environ.get("EMBED_CLASSIFY", "").strip().lower() in ("0", "false", "no", "off"):
        return False
    try:
        import sentence_transformers  # noqa: F401
    except Exception:
        return False
    return True


def model_name() -> str:
    return _MODEL_NAME


def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(_MODEL_NAME)
    return _model


def _labels(taxonomy: dict) -> tuple[list[tuple[str, str | None]], list[str]]:
    """Flatten the taxonomy into (master, sub) pairs and their text for embedding."""
    pairs: list[tuple[str, str | None]] = []
    texts: list[str] = []
    for cat in (taxonomy or {}).get("categories", []) or []:
        master = cat.get("master")
        if not master:
            continue
        subs = cat.get("subs") or [None]
        for sub in subs:
            pairs.append((master, sub))
            texts.append(f"{master} {sub or ''}".strip())
    return pairs, texts


def classify_items(items: list[dict], taxonomy: dict) -> list[dict]:
    """Assign each item its nearest taxonomy (master, sub) by cosine similarity.

    ``items`` = [{"id", "name", "category"}]; returns [{"id","master_category",
    "sub_category"}]. Items below the similarity floor (if set) get ("Other","Other").
    """
    pairs, label_texts = _labels(taxonomy)
    if not pairs or not items:
        return []
    model = _get_model()
    label_emb = model.encode(["passage: " + t for t in label_texts], normalize_embeddings=True)
    item_texts = ["query: " + f"{it.get('name') or ''} {it.get('category') or ''}".strip() for it in items]
    item_emb = model.encode(item_texts, normalize_embeddings=True)
    sims = item_emb @ label_emb.T  # cosine (rows already normalized)
    out: list[dict] = []
    for i, it in enumerate(items):
        row = sims[i]
        best = int(row.argmax())
        if _MIN_SIM and float(row[best]) < _MIN_SIM:
            out.append({"id": it["id"], "master_category": "Other", "sub_category": "Other"})
        else:
            master, sub = pairs[best]
            out.append({"id": it["id"], "master_category": master, "sub_category": sub})
    return out
