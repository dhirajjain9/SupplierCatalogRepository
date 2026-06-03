"""Pydantic schemas for request validation and response serialization."""
from __future__ import annotations

from datetime import datetime, date

from pydantic import BaseModel, ConfigDict, Field


# --------------------------------------------------------------------------- #
# Supplier
# --------------------------------------------------------------------------- #
class SupplierBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    contact_name: str | None = None
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    category: str | None = None
    notes: str | None = None


class SupplierCreate(SupplierBase):
    pass


class SupplierUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    contact_name: str | None = None
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    category: str | None = None
    notes: str | None = None


class SupplierOut(SupplierBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime


# --------------------------------------------------------------------------- #
# Catalog item
# --------------------------------------------------------------------------- #
class CatalogItemBase(BaseModel):
    sku: str | None = None
    name: str = Field(..., min_length=1, max_length=300)
    description: str | None = None
    unit: str | None = None
    category: str | None = None


class CatalogItemCreate(CatalogItemBase):
    supplier_id: int


class CatalogItemUpdate(BaseModel):
    sku: str | None = None
    name: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    unit: str | None = None
    category: str | None = None
    supplier_id: int | None = None


class CatalogItemOut(CatalogItemBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    supplier_id: int
    created_at: datetime


# --------------------------------------------------------------------------- #
# Quote
# --------------------------------------------------------------------------- #
class QuoteBase(BaseModel):
    unit_price: float = Field(..., ge=0)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    min_quantity: int = Field(default=1, ge=1)
    valid_from: date | None = None
    valid_until: date | None = None
    notes: str | None = None


class QuoteCreate(QuoteBase):
    catalog_item_id: int


class QuoteUpdate(BaseModel):
    unit_price: float | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    min_quantity: int | None = Field(default=None, ge=1)
    valid_from: date | None = None
    valid_until: date | None = None
    notes: str | None = None


class QuoteOut(QuoteBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    catalog_item_id: int
    created_at: datetime


# --------------------------------------------------------------------------- #
# Document
# --------------------------------------------------------------------------- #
class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    supplier_id: int | None = None
    catalog_item_id: int | None = None
    filename: str
    content_type: str | None = None
    size_bytes: int
    uploaded_at: datetime


# --------------------------------------------------------------------------- #
# Catalog import
# --------------------------------------------------------------------------- #
class ImportError(BaseModel):
    row: int
    error: str


class ImportSummary(BaseModel):
    supplier_id: int
    rows_parsed: int        # rows that passed validation
    items_created: int
    items_updated: int
    quotes_created: int
    rows_failed: int
    errors: list[ImportError] = []
