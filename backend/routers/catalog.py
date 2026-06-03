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
    search: str | None = Query(
        default=None, description="Substring match on name, SKU or description"
    ),
) -> list[models.CatalogItem]:
    stmt = select(models.CatalogItem).order_by(models.CatalogItem.name)
    if supplier_id is not None:
        stmt = stmt.where(models.CatalogItem.supplier_id == supplier_id)
    if category:
        stmt = stmt.where(models.CatalogItem.category == category)
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
