"""CRUD endpoints for suppliers."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend import models, schemas
from backend.database import get_db

router = APIRouter(prefix="/api/suppliers", tags=["suppliers"])


def _get_or_404(db: Session, supplier_id: int) -> models.Supplier:
    supplier = db.get(models.Supplier, supplier_id)
    if supplier is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Supplier not found")
    return supplier


@router.get("", response_model=list[schemas.SupplierOut])
def list_suppliers(
    db: Session = Depends(get_db),
    search: str | None = Query(default=None, description="Filter by name (substring)"),
    category: str | None = Query(default=None),
    type: str | None = Query(default=None, description="'supplier' or 'reference'"),
) -> list[models.Supplier]:
    stmt = select(models.Supplier).order_by(models.Supplier.name)
    if search:
        stmt = stmt.where(models.Supplier.name.ilike(f"%{search}%"))
    if category:
        stmt = stmt.where(models.Supplier.category == category)
    if type:
        stmt = stmt.where(models.Supplier.type == type)
    return list(db.scalars(stmt).all())


@router.post("", response_model=schemas.SupplierOut, status_code=status.HTTP_201_CREATED)
def create_supplier(
    payload: schemas.SupplierCreate, db: Session = Depends(get_db)
) -> models.Supplier:
    supplier = models.Supplier(**payload.model_dump())
    db.add(supplier)
    db.commit()
    db.refresh(supplier)
    return supplier


@router.get("/{supplier_id}", response_model=schemas.SupplierOut)
def get_supplier(supplier_id: int, db: Session = Depends(get_db)) -> models.Supplier:
    return _get_or_404(db, supplier_id)


@router.put("/{supplier_id}", response_model=schemas.SupplierOut)
def update_supplier(
    supplier_id: int, payload: schemas.SupplierUpdate, db: Session = Depends(get_db)
) -> models.Supplier:
    supplier = _get_or_404(db, supplier_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(supplier, field, value)
    db.commit()
    db.refresh(supplier)
    return supplier


@router.delete("/{supplier_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_supplier(supplier_id: int, db: Session = Depends(get_db)) -> None:
    supplier = _get_or_404(db, supplier_id)
    db.delete(supplier)
    db.commit()
