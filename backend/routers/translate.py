"""Endpoint for AI translation of catalog text (mainly Chinese → English)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from backend.services import translate as tr

router = APIRouter(prefix="/api/translate", tags=["translate"])


class TranslateIn(BaseModel):
    texts: list[str]


@router.get("/config")
def translate_config() -> dict:
    return {"enabled": tr.is_configured(), "model": tr.DEFAULT_MODEL}


@router.post("")
def do_translate(payload: TranslateIn) -> dict:
    """Translate a batch of strings; returns {translations: [...]} aligned to input."""
    texts = payload.texts or []
    if len(texts) > 200:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Too many strings in one batch (max 200).")
    try:
        return {"translations": tr.translate(texts)}
    except tr.TranslateNotConfigured as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except Exception as exc:  # surface provider errors cleanly
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Translation failed: {exc}")
