"""Competitive-coverage endpoints: derive a taxonomy, classify products into it,
and persist the master/sub category on items. The browser orchestrates batches
(like the rows import) to stay within serverless limits.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from backend import models, schemas
from backend.database import get_db
from backend.services import taxonomy

router = APIRouter(prefix="/api/taxonomy", tags=["analysis"])


@router.get("/config")
def taxonomy_config() -> dict:
    return {"enabled": taxonomy.is_configured(), "model": taxonomy.DEFAULT_MODEL}


@router.post("/suggest")
def suggest(payload: schemas.TaxonomySuggestIn) -> dict:
    try:
        return taxonomy.suggest_taxonomy(payload.samples)
    except taxonomy.VisionNotConfigured as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Taxonomy generation failed: {exc}")


@router.post("/classify")
def classify(payload: schemas.ClassifyIn) -> dict:
    try:
        results = taxonomy.classify_items(
            [i.model_dump() for i in payload.items], payload.taxonomy
        )
        return {"items": results}
    except taxonomy.VisionNotConfigured as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Classification failed: {exc}")


@router.put("/save")
def save_classification(payload: schemas.ClassifySaveIn, db: Session = Depends(get_db)) -> dict:
    """Persist master/sub categories onto items (bulk)."""
    updated = 0
    for r in payload.items:
        item = db.get(models.CatalogItem, r.id)
        if item is None:
            continue
        item.master_category = r.master_category
        item.sub_category = r.sub_category
        updated += 1
    db.commit()
    return {"updated": updated}
