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

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select, update
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


class MergeSuppliersIn(BaseModel):
    source_ids: list[int]            # suppliers to fold in (and then delete)
    target_id: int | None = None     # merge into this existing supplier, or…
    target_name: str | None = None   # …this name (reused if it exists, else created)


@router.post("/merge-suppliers")
def merge_suppliers(payload: MergeSuppliersIn, db: Session = Depends(get_db)) -> dict:
    """Fold several suppliers into one: move all their items, documents and quotes
    (quotes follow their items) to the target, then delete the now-empty sources.

    The target is an existing supplier (``target_id``) or one resolved/created from
    ``target_name``. Item de-duplication is left to the caller — merged sources may
    contribute items with the same SKU/name."""
    target: models.Supplier | None = None
    if payload.target_id is not None:
        target = db.get(models.Supplier, payload.target_id)
        if target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "target_id not found")
    elif payload.target_name and payload.target_name.strip():
        name = payload.target_name.strip()
        target = db.scalar(select(models.Supplier).where(func.lower(models.Supplier.name) == name.lower()))
        if target is None:
            # New target inherits the type of the first source so it lands in the
            # right tab (suppliers vs competitors).
            first = next((db.get(models.Supplier, s) for s in payload.source_ids if db.get(models.Supplier, s)), None)
            target = models.Supplier(name=name, type=(first.type if first else "supplier"))
            db.add(target)
            db.flush()
    if target is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Provide target_id or target_name")

    src_ids = [s for s in dict.fromkeys(payload.source_ids) if s != target.id and db.get(models.Supplier, s)]
    items_moved = 0
    if src_ids:
        items_moved = db.execute(
            update(models.CatalogItem).where(models.CatalogItem.supplier_id.in_(src_ids))
            .values(supplier_id=target.id)
        ).rowcount or 0
        db.execute(
            update(models.Document).where(models.Document.supplier_id.in_(src_ids))
            .values(supplier_id=target.id)
        )
        # Items/docs are already reassigned, so deleting the sources cascades nothing.
        db.execute(delete(models.Supplier).where(models.Supplier.id.in_(src_ids)))
    db.commit()
    return {"target_id": target.id, "target_name": target.name,
            "merged": len(src_ids), "items_moved": items_moved}
