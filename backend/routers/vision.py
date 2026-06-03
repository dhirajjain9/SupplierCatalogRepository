"""Endpoints for AI vision extraction of image-only catalog pages.

The browser renders each PDF page to a compact image and posts it here one at a
time. We call Claude to extract the products on that page and return them as
JSON; the browser collects results across pages, lets the user review, then
saves via the normal /api/catalog-import/rows endpoint.
"""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile, status

from backend.services import vision

router = APIRouter(prefix="/api/vision", tags=["vision"])


@router.get("/config")
def vision_config() -> dict:
    """Tell the UI whether AI extraction is available (key configured)."""
    return {"enabled": vision.is_configured(), "model": vision.DEFAULT_MODEL}


@router.post("/extract")
async def vision_extract(file: UploadFile = File(...)) -> dict:
    """Extract products from a single catalog page image."""
    data = await file.read()
    media_type = file.content_type or "image/jpeg"
    try:
        return vision.extract_products(data, media_type)
    except vision.VisionNotConfigured as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except Exception as exc:  # surface provider errors as a clean message
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"AI extraction failed: {exc}")
