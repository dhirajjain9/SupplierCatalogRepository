"""CRUD endpoints for catalog items."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend import models, schemas
from backend.database import get_db

router = APIRouter(prefix="/api/catalog-items", tags=["catalog"])


def _get_or_404(db: Session, item_id: int) -> models.CatalogItem:
    item = db.get(models.CatalogItem, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Catalog item not found")
    return item


def _ensure_supplier(db: Session, supplier_id: int) -> None:
    if db.get(models.Supplier, supplier_id) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "supplier_id does not exist")


@router.get("", response_model=list[schemas.CatalogItemOut])
def list_items(
    db: Session = Depends(get_db),
    supplier_id: int | None = Query(default=None),
    category: str | None = Query(default=None, description="Filter by product type/category"),
    master_category: str | None = Query(default=None),
    sub_category: str | None = Query(default=None),
    search: str | None = Query(
        default=None, description="Substring match on name, SKU or description"
    ),
) -> list[models.CatalogItem]:
    stmt = select(models.CatalogItem).order_by(models.CatalogItem.name)
    if supplier_id is not None:
        stmt = stmt.where(models.CatalogItem.supplier_id == supplier_id)
    if category:
        stmt = stmt.where(models.CatalogItem.category == category)
    if master_category:
        stmt = stmt.where(models.CatalogItem.master_category == master_category)
    if sub_category:
        stmt = stmt.where(models.CatalogItem.sub_category == sub_category)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(
            models.CatalogItem.name.ilike(like)
            | models.CatalogItem.sku.ilike(like)
            | models.CatalogItem.description.ilike(like)
        )
    return list(db.scalars(stmt).all())


@router.get("/categories", response_model=list[str])
def list_categories(db: Session = Depends(get_db)) -> list[str]:
    """Distinct, non-empty product-type categories — used to populate filters."""
    stmt = (
        select(models.CatalogItem.category)
        .where(models.CatalogItem.category.is_not(None))
        .distinct()
        .order_by(models.CatalogItem.category)
    )
    return [c for c in db.scalars(stmt).all() if c]


@router.get("/stats")
def category_stats(db: Session = Depends(get_db)) -> list[dict]:
    """Product counts grouped by supplier + master/sub category (for dashboards)."""
    from sqlalchemy import func
    rows = db.execute(
        select(
            models.CatalogItem.supplier_id,
            models.CatalogItem.master_category,
            models.CatalogItem.sub_category,
            func.count().label("n"),
        ).group_by(
            models.CatalogItem.supplier_id,
            models.CatalogItem.master_category,
            models.CatalogItem.sub_category,
        )
    ).all()
    return [
        {"supplier_id": s, "master_category": m, "sub_category": sub, "count": n}
        for (s, m, sub, n) in rows
    ]


@router.post("/cleanup")
def cleanup_items(dry_run: bool = Query(default=False), db: Session = Depends(get_db)) -> dict:
    """Find (and optionally delete) non-product rows: banner/summary lines and
    junk that scraped sheets sometimes include. Pass dry_run=true to preview."""
    import re
    banner = re.compile(
        r"(total products|products with reviews|%?\s*coverage|product types|"
        r"top \d+ categor|platform reviews|overall avg|avg rating|across \d+ collections)",
        re.I,
    )
    junk_cats = {"assigned category", "unset", "unassigned", "other category"}
    numeric_only = re.compile(r"^[\d.,%₹★\s/\-]+$")
    removed = []
    for it in db.scalars(select(models.CatalogItem)).all():
        name = (it.name or "").strip()
        mc = (it.master_category or "").strip().lower()
        sc = it.sub_category or ""
        is_junk = (
            not name
            or "\n" in name
            or numeric_only.match(name)
            or bool(banner.search(name))
            or "\n" in sc
            or bool(banner.search(sc))
            or mc in junk_cats
        )
        if is_junk:
            removed.append(it.name)
            if not dry_run:
                db.delete(it)
    if not dry_run:
        db.commit()
    return {"count": len(removed), "names": removed[:100], "dry_run": dry_run}


@router.post("", response_model=schemas.CatalogItemOut, status_code=status.HTTP_201_CREATED)
def create_item(
    payload: schemas.CatalogItemCreate, db: Session = Depends(get_db)
) -> models.CatalogItem:
    _ensure_supplier(db, payload.supplier_id)
    item = models.CatalogItem(**payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("/{item_id}", response_model=schemas.CatalogItemOut)
def get_item(item_id: int, db: Session = Depends(get_db)) -> models.CatalogItem:
    return _get_or_404(db, item_id)


@router.put("/{item_id}", response_model=schemas.CatalogItemOut)
def update_item(
    item_id: int, payload: schemas.CatalogItemUpdate, db: Session = Depends(get_db)
) -> models.CatalogItem:
    item = _get_or_404(db, item_id)
    data = payload.model_dump(exclude_unset=True)
    if "supplier_id" in data:
        _ensure_supplier(db, data["supplier_id"])
    for field, value in data.items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(item_id: int, db: Session = Depends(get_db)) -> None:
    item = _get_or_404(db, item_id)
    db.delete(item)
    db.commit()
