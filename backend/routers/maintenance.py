"""Maintenance endpoints: clean up after repeated imports.

Re-importing the same catalog (especially an .xlsx with embedded photos) can
leave an item with several identical images, and auto-detecting suppliers across
uploads can create near-duplicate supplier rows. These endpoints let the owner
inspect and fix that without touching the imported catalog data itself.
"""
from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])


def _image_dupe_groups(db: Session) -> dict[tuple, list[models.Document]]:
    """Group image documents that are byte-identical within the same item (or,
    for supplier-only images, the same supplier). Each group's extras are
    redundant copies left by repeated imports."""
    docs = db.scalars(select(models.Document).where(models.Document.kind == "image")).all()
    groups: dict[tuple, list[models.Document]] = defaultdict(list)
    for d in docs:
        if d.data is None:  # legacy disk-stored rows have no bytes to compare
            continue
        h = hashlib.sha256(d.data).hexdigest()
        groups[(d.catalog_item_id, d.supplier_id, h)].append(d)
    return {k: v for k, v in groups.items() if len(v) > 1}


def _duplicate_suppliers(db: Session) -> list[dict]:
    """Suppliers whose names collapse to the same value (case/space-insensitive)."""
    by_name: dict[str, list[models.Supplier]] = defaultdict(list)
    for s in db.scalars(select(models.Supplier)).all():
        by_name[(s.name or "").strip().lower()].append(s)
    out = []
    for name, group in by_name.items():
        if len(group) > 1:
            out.append({
                "name": group[0].name,
                "count": len(group),
                "ids": sorted(s.id for s in group),
            })
    return sorted(out, key=lambda d: -d["count"])


@router.get("/duplicates")
def report_duplicates(db: Session = Depends(get_db)) -> dict:
    """Read-only: how much duplication repeated imports left behind."""
    dupe_groups = _image_dupe_groups(db)
    removable_images = sum(len(v) - 1 for v in dupe_groups.values())
    return {
        "duplicate_images": {
            "groups": len(dupe_groups),
            "removable": removable_images,  # how many image rows dedupe would delete
        },
        "duplicate_suppliers": _duplicate_suppliers(db),
    }


@router.post("/dedupe-images")
def dedupe_images(db: Session = Depends(get_db)) -> dict:
    """Delete byte-identical duplicate images, keeping the earliest of each set.

    Safe and idempotent: only exact-duplicate copies attached to the *same* item
    (or supplier) are removed; distinct photos and the same photo on different
    items are left untouched. Running it again removes nothing."""
    removed = 0
    for group in _image_dupe_groups(db).values():
        group.sort(key=lambda d: (d.uploaded_at or datetime.min, d.id))
        for extra in group[1:]:  # keep group[0], delete the rest
            db.delete(extra)
            removed += 1
    db.commit()
    return {"removed": removed}
