"""CRUD endpoints for price quotes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend import models, schemas
from backend.database import get_db

router = APIRouter(prefix="/api/quotes", tags=["quotes"])


def _get_or_404(db: Session, quote_id: int) -> models.Quote:
    quote = db.get(models.Quote, quote_id)
    if quote is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Quote not found")
    return quote


def _ensure_item(db: Session, item_id: int) -> None:
    if db.get(models.CatalogItem, item_id) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "catalog_item_id does not exist")


@router.get("", response_model=list[schemas.QuoteOut])
def list_quotes(
    db: Session = Depends(get_db),
    catalog_item_id: int | None = Query(default=None),
) -> list[models.Quote]:
    stmt = select(models.Quote).order_by(models.Quote.created_at.desc())
    if catalog_item_id is not None:
        stmt = stmt.where(models.Quote.catalog_item_id == catalog_item_id)
    return list(db.scalars(stmt).all())


@router.post("", response_model=schemas.QuoteOut, status_code=status.HTTP_201_CREATED)
def create_quote(
    payload: schemas.QuoteCreate, db: Session = Depends(get_db)
) -> models.Quote:
    _ensure_item(db, payload.catalog_item_id)
    quote = models.Quote(**payload.model_dump())
    db.add(quote)
    db.commit()
    db.refresh(quote)
    return quote


@router.get("/{quote_id}", response_model=schemas.QuoteOut)
def get_quote(quote_id: int, db: Session = Depends(get_db)) -> models.Quote:
    return _get_or_404(db, quote_id)


@router.put("/{quote_id}", response_model=schemas.QuoteOut)
def update_quote(
    quote_id: int, payload: schemas.QuoteUpdate, db: Session = Depends(get_db)
) -> models.Quote:
    quote = _get_or_404(db, quote_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(quote, field, value)
    db.commit()
    db.refresh(quote)
    return quote


@router.delete("/{quote_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_quote(quote_id: int, db: Session = Depends(get_db)) -> None:
    quote = _get_or_404(db, quote_id)
    db.delete(quote)
    db.commit()
