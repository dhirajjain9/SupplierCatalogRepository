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
    type: str = "supplier"  # "supplier" | "reference"
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
    type: str | None = None
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
    master_category: str | None = None
    sub_category: str | None = None
    # Full original imported row (every source column), when the item came
    # from a file import.
    attributes: dict | None = None
    created_at: datetime


# --------------------------------------------------------------------------- #
# Taxonomy / classification (competitive coverage)
# --------------------------------------------------------------------------- #
class TaxonomySuggestIn(BaseModel):
    samples: list[str] = []           # product names/categories to derive a taxonomy from


class ClassifyItemIn(BaseModel):
    id: int
    name: str
    category: str | None = None


class ClassifyIn(BaseModel):
    taxonomy: dict = {}               # {"categories":[{"master":..,"subs":[..]}]}
    items: list[ClassifyItemIn] = []


class ClassifyResult(BaseModel):
    id: int
    master_category: str | None = None
    sub_category: str | None = None


class ClassifySaveIn(BaseModel):
    items: list[ClassifyResult] = []


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
    kind: str = "document"
    uploaded_at: datetime


# --------------------------------------------------------------------------- #
# Catalog import
# --------------------------------------------------------------------------- #
class ImportWarning(BaseModel):
    row: int
    warning: str


class ImportRowIn(BaseModel):
    """A single parsed row sent from the browser (file parsed client-side)."""
    name: str
    sku: str | None = None
    unit: str | None = None
    category: str | None = None
    description: str | None = None
    unit_price: float | None = None
    currency: str = "USD"
    min_quantity: int = 1
    source_row: int = 0
    supplier_name: str | None = None
    supplier_info: dict[str, str] = {}
    attributes: dict = {}


class RowsImport(BaseModel):
    """Batch of parsed rows for catalog/quotation import (bypasses upload size limits)."""
    supplier_id: int | None = None
    supplier_name: str | None = None
    type: str | None = None  # type for a newly-created supplier ('supplier'|'reference')
    rows: list[ImportRowIn] = []
    warnings: list[ImportWarning] = []


class SheetImport(BaseModel):
    """Import a competitor/supplier catalog straight from a shared Google Sheet."""
    url: str
    tab: str | None = None            # specific worksheet/tab name (else the URL's gid / first tab)
    supplier_id: int | None = None
    supplier_name: str | None = None
    type: str | None = None  # 'reference' or 'supplier' (applied to a newly-created supplier)


class SheetPreview(BaseModel):
    url: str
    tab: str | None = None


class MappedSheetImport(BaseModel):
    """Import a sheet using an explicit column mapping (for scraped/odd layouts)."""
    url: str
    tab: str | None = None
    supplier_id: int | None = None
    supplier_name: str | None = None
    type: str | None = None
    first_data_row: int = 1           # 1-based row where products start
    header_row: int | None = None     # 1-based row to use as attribute headers (optional)
    mapping: dict[str, int] = {}      # field -> 0-based column index; field in
                                      # name|sku|master_category|sub_category|price|description


class ImportSummary(BaseModel):
    supplier_id: int | None = None      # set when the import targets one supplier
    rows_captured: int       # every non-empty row in the file is imported
    items_created: int
    items_updated: int
    quotes_created: int
    suppliers_created: int = 0  # suppliers auto-created from the file/form
    images_attached: int = 0  # images embedded in an .xlsx that matched a row
    rows_with_warnings: int  # imported, but a value couldn't be typed
    item_ids: list[int | None] = []  # created/updated item id per input row (for photo linking)
    warnings: list[ImportWarning] = []


class QuotationSummary(BaseModel):
    """Step 2: attach prices/MOQ from a quotation onto existing catalog items."""
    supplier_id: int | None = None
    quotes_created: int
    items_matched: int       # distinct catalog items a quote was attached to
    rows_unmatched: int      # rows whose SKU wasn't found in the catalog
    rows_without_price: int  # matched rows that carried no usable price
    warnings: list[ImportWarning] = []


class ImageImportSummary(BaseModel):
    supplier_id: int | None = None
    images_stored: int
    images_unmatched: list[str] = []  # filenames whose SKU had no catalog item
    files_skipped: list[str] = []     # non-image entries that were ignored
