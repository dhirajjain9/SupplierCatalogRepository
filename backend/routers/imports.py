"""Bulk import endpoints for catalogs, quotations and images.

Suppliers are resolved automatically: a catalog/quotation file may carry a
``Supplier`` column (and optional contact columns), so the supplier is created
or looked up during import — adding a supplier is no longer a required first
step. A supplier can also be supplied via the form (an existing ``supplier_id``
or a new ``supplier_name``), which acts as the default for rows that don't name
one themselves.

Endpoints come in two flavours:
  * ``/api/catalog-import`` etc.                — supplier-agnostic (resolve from file/form)
  * ``/api/suppliers/{id}/catalog-import`` etc. — pin every row to one supplier
"""
from __future__ import annotations

import io
import re
import urllib.request
import zipfile

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend import models, schemas
from backend.database import get_db
from backend.services import catalog_import, images
from backend.services.storage import store_file

router = APIRouter(prefix="/api", tags=["import"])

_SUPPLIER_FIELDS = ("email", "phone", "contact_name", "category", "address")


# --------------------------------------------------------------------------- #
# Supplier resolution
# --------------------------------------------------------------------------- #
def _require_supplier(db: Session, supplier_id: int) -> models.Supplier:
    supplier = db.get(models.Supplier, supplier_id)
    if supplier is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Supplier not found")
    return supplier


def _existing_supplier(db: Session, name: str) -> models.Supplier | None:
    return db.scalar(
        select(models.Supplier).where(func.lower(models.Supplier.name) == name.strip().lower())
    )


class _SupplierResolver:
    """Find-or-create suppliers by name within a single import, caching results
    and counting how many were newly created."""

    def __init__(self, db: Session, default: models.Supplier | None, default_type: str | None = None):
        self.db = db
        self.default = default
        self.default_type = default_type if default_type in ("supplier", "reference") else None
        self.created = 0
        self._cache: dict[str, models.Supplier] = {}
        if default is not None:
            self._cache[default.name.strip().lower()] = default

    def resolve(self, name: str | None, info: dict | None = None) -> models.Supplier | None:
        """Supplier for a row: the named one (created if needed), else the default."""
        name = (name or "").strip()
        if not name:
            return self.default
        key = name.lower()
        supplier = self._cache.get(key) or _existing_supplier(self.db, name)
        if supplier is None:
            supplier = models.Supplier(name=name)
            if self.default_type:
                supplier.type = self.default_type
            self.db.add(supplier)
            self.created += 1
        # Enrich blank contact fields from the file when available.
        for f in _SUPPLIER_FIELDS:
            if info and info.get(f) and not getattr(supplier, f, None):
                setattr(supplier, f, info[f])
        self.db.flush()
        self._cache[key] = supplier
        return supplier


def _form_default_supplier(
    db: Session, supplier_id: int | None, supplier_name: str | None, type: str | None = None,
) -> tuple[models.Supplier | None, int]:
    """Resolve the optional form-level supplier. Returns (supplier, created_count).

    ``type`` ('supplier'|'reference') is applied only when creating a new supplier.
    """
    if supplier_id is not None:
        return _require_supplier(db, supplier_id), 0
    name = (supplier_name or "").strip()
    if name:
        existing = _existing_supplier(db, name)
        if existing:
            return existing, 0
        supplier = models.Supplier(name=name)
        if type in ("supplier", "reference"):
            supplier.type = type
        db.add(supplier)
        db.flush()
        return supplier, 1
    return None, 0


def _sheet_csv_url(url: str, tab: str | None = None) -> str:
    """Turn a Google Sheets share/edit URL into a CSV export URL.

    If ``tab`` (a worksheet name) is given, use the gviz endpoint to fetch that
    specific tab; otherwise export the tab referenced by the URL's gid (or the
    first tab).
    """
    url = (url or "").strip()
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", url)
    if m:
        sid = m.group(1)
        if tab and tab.strip():
            import urllib.parse
            return (f"https://docs.google.com/spreadsheets/d/{sid}/gviz/tq"
                    f"?tqx=out:csv&sheet={urllib.parse.quote(tab.strip())}")
        gid = re.search(r"[#&?]gid=(\d+)", url)
        gid = gid.group(1) if gid else "0"
        return f"https://docs.google.com/spreadsheets/d/{sid}/export?format=csv&gid={gid}"
    if "output=csv" in url or "format=csv" in url:  # already a published CSV link
        return url
    raise HTTPException(status.HTTP_400_BAD_REQUEST, "That doesn't look like a Google Sheets link.")


def _fetch_google_sheet(url: str, tab: str | None = None) -> bytes:
    csv_url = _sheet_csv_url(url, tab)
    req = urllib.request.Request(csv_url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            ctype = resp.headers.get("Content-Type", "")
            data = resp.read()
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Couldn't fetch the sheet: {exc}")
    if "text/html" in ctype.lower():
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This sheet isn't publicly accessible. In Google Sheets set Share → "
            "'Anyone with the link' (Viewer), or File → Share → Publish to web, then retry.",
        )
    return data


def _parse_or_400(file: UploadFile, data: bytes) -> catalog_import.ImportResult:
    try:
        return catalog_import.parse_catalog_file(file.filename or "", file.content_type, data)
    except catalog_import.UnsupportedFileType as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


# --------------------------------------------------------------------------- #
# Core import routines (shared by both endpoint styles)
# --------------------------------------------------------------------------- #
def _persist_catalog(
    db: Session, rows: list[catalog_import.ParsedRow], warnings: list[dict],
    default_supplier: models.Supplier | None, suppliers_pre_created: int = 0,
    source_type: str | None = None,
) -> tuple[schemas.ImportSummary, dict[int, models.CatalogItem]]:
    """Upsert parsed rows into items/quotes. Does NOT commit (caller commits).

    Returns the summary and a {source_row: item} map (used to attach embedded
    images on the file-upload path).
    """
    resolver = _SupplierResolver(db, default_supplier, source_type)
    has_file_supplier = any(r.supplier_name for r in rows)
    if default_supplier is None and not has_file_supplier:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "No supplier found. Add a 'Supplier' column to your file, or choose/enter "
            "a supplier when importing.",
        )

    items_created = items_updated = quotes_created = 0
    warnings = list(warnings)
    row_to_item: dict[int, models.CatalogItem] = {}
    item_ids: list[int | None] = []

    # Preload each supplier's existing items once into {sku} / {name} lookups so
    # we don't issue a SELECT per row (keeps large imports fast). The cache is
    # updated as we insert, so duplicates within one import collapse too.
    caches: dict[int, dict] = {}

    def _cache(sid: int) -> dict:
        if sid not in caches:
            c = {"sku": {}, "name": {}}
            for it in db.scalars(select(models.CatalogItem).where(models.CatalogItem.supplier_id == sid)).all():
                if it.sku:
                    c["sku"][it.sku] = it
                else:
                    c["name"][(it.name or "").strip().lower()] = it
            caches[sid] = c
        return caches[sid]

    for row in rows:
        supplier = resolver.resolve(row.supplier_name, row.supplier_info)
        if supplier is None:
            warnings.append({"row": row.source_row, "warning": "No supplier for this row; skipped"})
            item_ids.append(None)
            continue

        c = _cache(supplier.id)
        namekey = (row.name or "").strip().lower()
        item = c["sku"].get(row.sku) if row.sku else c["name"].get(namekey)
        if item is None:
            item = models.CatalogItem(supplier_id=supplier.id, name=row.name, sku=row.sku)
            db.add(item)
            items_created += 1
            if row.sku:
                c["sku"][row.sku] = item
            elif namekey:
                c["name"][namekey] = item
        else:
            item.name = row.name
            items_updated += 1

        item.unit = row.unit
        item.category = row.category
        if row.master_category:
            item.master_category = row.master_category
        if row.sub_category:
            item.sub_category = row.sub_category
        item.description = row.description
        item.attributes = row.attributes
        db.flush()
        row_to_item[row.source_row] = item
        item_ids.append(item.id)

        if row.has_price:
            db.add(models.Quote(
                catalog_item_id=item.id, unit_price=row.unit_price,
                currency=row.currency, min_quantity=row.min_quantity,
            ))
            quotes_created += 1

    summary = schemas.ImportSummary(
        supplier_id=default_supplier.id if default_supplier else None,
        rows_captured=len(rows),
        items_created=items_created,
        items_updated=items_updated,
        quotes_created=quotes_created,
        suppliers_created=resolver.created + suppliers_pre_created,
        images_attached=0,
        rows_with_warnings=len(warnings),
        item_ids=item_ids,
        warnings=[schemas.ImportWarning(**w) for w in warnings],
    )
    return summary, row_to_item


def _rows_to_parsed(rows: list[schemas.ImportRowIn]) -> list[catalog_import.ParsedRow]:
    return [
        catalog_import.ParsedRow(
            name=r.name, sku=r.sku, unit=r.unit, category=r.category,
            description=r.description, unit_price=r.unit_price, currency=r.currency,
            min_quantity=r.min_quantity, source_row=r.source_row,
            supplier_name=r.supplier_name, supplier_info=dict(r.supplier_info or {}),
            attributes=dict(r.attributes or {}),
        )
        for r in rows
    ]


def _run_catalog_import(
    db: Session, file: UploadFile, data: bytes, default_supplier: models.Supplier | None,
    suppliers_pre_created: int = 0,
) -> schemas.ImportSummary:
    result = _parse_or_400(file, data)
    summary, row_to_item = _persist_catalog(
        db, result.rows, result.warnings, default_supplier, suppliers_pre_created
    )
    if (file.filename or "").lower().endswith(".xlsx"):
        for img in images.extract_xlsx_images(data):
            item = row_to_item.get(img.source_row or -1)
            if item is None:
                continue
            db.add(store_file(
                img.data, img.filename, img.content_type,
                supplier_id=item.supplier_id, catalog_item_id=item.id, kind="image",
            ))
            summary.images_attached += 1
    db.commit()
    return summary


def _persist_quotation(
    db: Session, rows: list[catalog_import.ParsedRow], warnings: list[dict],
    default_supplier: models.Supplier | None,
) -> schemas.QuotationSummary:
    """Attach quotes to existing items by SKU. Does NOT commit (caller commits)."""
    quotes_created = rows_unmatched = rows_without_price = 0
    matched_items: set[int] = set()
    warnings = list(warnings)

    for row in rows:
        if not row.sku:
            rows_unmatched += 1
            warnings.append({"row": row.source_row, "warning": "No SKU; cannot match to catalog"})
            continue
        # Scope matching to the row's supplier (if named & known) else the default.
        scope = _existing_supplier(db, row.supplier_name) if row.supplier_name else default_supplier
        stmt = select(models.CatalogItem).where(models.CatalogItem.sku == row.sku)
        if scope is not None:
            stmt = stmt.where(models.CatalogItem.supplier_id == scope.id)
        item = db.scalars(stmt).first()
        if item is None:
            rows_unmatched += 1
            warnings.append({"row": row.source_row, "warning": f"SKU {row.sku!r} not in catalog"})
            continue
        if not row.has_price:
            rows_without_price += 1
            warnings.append({"row": row.source_row, "warning": f"SKU {row.sku!r}: no price to quote"})
            continue
        db.add(models.Quote(
            catalog_item_id=item.id, unit_price=row.unit_price,
            currency=row.currency, min_quantity=row.min_quantity,
        ))
        quotes_created += 1
        matched_items.add(item.id)

    return schemas.QuotationSummary(
        supplier_id=default_supplier.id if default_supplier else None,
        quotes_created=quotes_created,
        items_matched=len(matched_items),
        rows_unmatched=rows_unmatched,
        rows_without_price=rows_without_price,
        warnings=[schemas.ImportWarning(**w) for w in warnings],
    )


def _run_quotation_import(
    db: Session, file: UploadFile, data: bytes, default_supplier: models.Supplier | None
) -> schemas.QuotationSummary:
    result = _parse_or_400(file, data)
    summary = _persist_quotation(db, result.rows, result.warnings, default_supplier)
    db.commit()
    return summary


def _run_images_import(
    db: Session, file: UploadFile, data: bytes, supplier_id: int | None
) -> schemas.ImageImportSummary:
    name = (file.filename or "").lower()
    if name.endswith(".zip"):
        extracted = images.extract_zip_images(data)
        skipped = _zip_non_images(data)
    elif images.is_image(name):
        extracted = [images.ExtractedImage(
            filename=file.filename, data=data,
            content_type=file.content_type or images.content_type_for(name),
        )]
        skipped = []
    else:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Upload a .zip of images or a single image file (.jpg/.png/…).",
        )

    stored = 0
    unmatched: list[str] = []
    for img in extracted:
        item = _find_item_for_image(db, supplier_id, img.filename)
        if item is None:
            unmatched.append(img.filename)
            continue
        db.add(store_file(
            img.data, img.filename, img.content_type,
            supplier_id=item.supplier_id, catalog_item_id=item.id, kind="image",
        ))
        stored += 1
    db.commit()
    return schemas.ImageImportSummary(
        supplier_id=supplier_id,
        images_stored=stored,
        images_unmatched=unmatched,
        files_skipped=skipped,
    )


def _find_item_for_image(
    db: Session, supplier_id: int | None, filename: str
) -> models.CatalogItem | None:
    """Match an image to an item by the SKU in its name, scoped to a supplier if given."""
    for sku in images.sku_candidates(filename):
        stmt = select(models.CatalogItem).where(models.CatalogItem.sku == sku)
        if supplier_id is not None:
            stmt = stmt.where(models.CatalogItem.supplier_id == supplier_id)
        item = db.scalars(stmt).first()
        if item is not None:
            return item
    return None


def _zip_non_images(data: bytes) -> list[str]:
    skipped: list[str] = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            base = info.filename.rsplit("/", 1)[-1]
            if info.is_dir() or base.startswith("."):
                continue
            if not images.is_image(info.filename):
                skipped.append(base)
    return skipped


# --------------------------------------------------------------------------- #
# Endpoints — supplier-agnostic (resolve supplier from the file/form)
# --------------------------------------------------------------------------- #
@router.get("/catalog-import/template", response_class=PlainTextResponse)
def download_template() -> PlainTextResponse:
    return PlainTextResponse(
        catalog_import.template_csv(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="catalog-template.csv"'},
    )


@router.post("/catalog-import/rows", response_model=schemas.ImportSummary)
def import_catalog_rows(
    payload: schemas.RowsImport, db: Session = Depends(get_db),
) -> schemas.ImportSummary:
    """Persist a batch of rows parsed in the browser (no file upload size limit)."""
    default, created = _form_default_supplier(
        db, payload.supplier_id, payload.supplier_name, payload.type
    )
    warnings = [w.model_dump() for w in payload.warnings]
    summary, _ = _persist_catalog(
        db, _rows_to_parsed(payload.rows), warnings, default, created, source_type=payload.type
    )
    db.commit()
    return summary


@router.post("/sheet-preview")
def sheet_preview(payload: schemas.SheetPreview) -> dict:
    """Return the first rows of a sheet so the UI can offer a column mapping."""
    import csv as _csv
    data = _fetch_google_sheet(payload.url, payload.tab)
    rows = list(_csv.reader(io.StringIO(data.decode("utf-8-sig", errors="replace"))))
    ncols = max((len(r) for r in rows[:30]), default=0)
    return {"rows": [r[:ncols] for r in rows[:15]], "ncols": ncols, "total_rows": len(rows)}


@router.post("/sheet-import-mapped", response_model=schemas.ImportSummary)
def import_sheet_mapped(payload: schemas.MappedSheetImport, db: Session = Depends(get_db)) -> schemas.ImportSummary:
    """Import a sheet using an explicit column mapping (handles scraped layouts)."""
    import csv as _csv
    data = _fetch_google_sheet(payload.url, payload.tab)
    grid = list(_csv.reader(io.StringIO(data.decode("utf-8-sig", errors="replace"))))
    m = payload.mapping
    if "name" not in m:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please map the Name column.")

    header = grid[payload.header_row - 1] if payload.header_row and payload.header_row <= len(grid) else None

    def cell(row, idx):
        return (row[idx].strip() if idx is not None and 0 <= idx < len(row) and row[idx] else None)

    parsed: list[catalog_import.ParsedRow] = []
    for n, raw in enumerate(grid[payload.first_data_row - 1:], start=payload.first_data_row):
        name = cell(raw, m.get("name"))
        if not name:
            continue
        attrs = {}
        for i, v in enumerate(raw):
            v = (v or "").strip()
            if v:
                attrs[(header[i].strip() if header and i < len(header) and header[i].strip() else f"Column {i + 1}")] = v
        sub = cell(raw, m.get("sub_category"))
        row = catalog_import.ParsedRow(
            name=name, sku=cell(raw, m.get("sku")),
            master_category=cell(raw, m.get("master_category")), sub_category=sub,
            category=sub, description=cell(raw, m.get("description")),
            source_row=n, attributes=attrs,
        )
        parsed.append(row)

    default, created = _form_default_supplier(db, payload.supplier_id, payload.supplier_name, payload.type)
    summary, _ = _persist_catalog(db, parsed, [], default, created, source_type=payload.type)
    db.commit()
    return summary


@router.post("/sheet-import", response_model=schemas.ImportSummary)
def import_sheet(payload: schemas.SheetImport, db: Session = Depends(get_db)) -> schemas.ImportSummary:
    """Import a catalog directly from a shared/published Google Sheet (CSV)."""
    data = _fetch_google_sheet(payload.url, payload.tab)
    result = catalog_import.parse_catalog_file("sheet.csv", "text/csv", data)
    default, created = _form_default_supplier(
        db, payload.supplier_id, payload.supplier_name, payload.type
    )
    summary, _ = _persist_catalog(
        db, result.rows, result.warnings, default, created, source_type=payload.type
    )
    db.commit()
    return summary


@router.post("/quotation-import/rows", response_model=schemas.QuotationSummary)
def import_quotation_rows(
    payload: schemas.RowsImport, db: Session = Depends(get_db),
) -> schemas.QuotationSummary:
    default, _ = _form_default_supplier(db, payload.supplier_id, payload.supplier_name)
    warnings = [w.model_dump() for w in payload.warnings]
    summary = _persist_quotation(db, _rows_to_parsed(payload.rows), warnings, default)
    db.commit()
    return summary


@router.post("/catalog-import", response_model=schemas.ImportSummary)
async def import_catalog_auto(
    file: UploadFile = File(...),
    supplier_id: int | None = Form(default=None),
    supplier_name: str | None = Form(default=None),
    db: Session = Depends(get_db),
) -> schemas.ImportSummary:
    default, created = _form_default_supplier(db, supplier_id, supplier_name)
    return _run_catalog_import(db, file, await file.read(), default, created)


@router.post("/quotation-import", response_model=schemas.QuotationSummary)
async def import_quotation_auto(
    file: UploadFile = File(...),
    supplier_id: int | None = Form(default=None),
    supplier_name: str | None = Form(default=None),
    db: Session = Depends(get_db),
) -> schemas.QuotationSummary:
    default, _ = _form_default_supplier(db, supplier_id, supplier_name)
    return _run_quotation_import(db, file, await file.read(), default)


@router.post("/images-import", response_model=schemas.ImageImportSummary)
async def import_images_auto(
    file: UploadFile = File(...),
    supplier_id: int | None = Form(default=None),
    db: Session = Depends(get_db),
) -> schemas.ImageImportSummary:
    if supplier_id is not None:
        _require_supplier(db, supplier_id)
    return _run_images_import(db, file, await file.read(), supplier_id)


# --------------------------------------------------------------------------- #
# Endpoints — pinned to a specific supplier (kept for direct/per-supplier use)
# --------------------------------------------------------------------------- #
@router.post("/suppliers/{supplier_id}/catalog-import", response_model=schemas.ImportSummary)
async def import_catalog(
    supplier_id: int, file: UploadFile = File(...), db: Session = Depends(get_db),
) -> schemas.ImportSummary:
    return _run_catalog_import(db, file, await file.read(), _require_supplier(db, supplier_id))


@router.post("/suppliers/{supplier_id}/quotation-import", response_model=schemas.QuotationSummary)
async def import_quotation(
    supplier_id: int, file: UploadFile = File(...), db: Session = Depends(get_db),
) -> schemas.QuotationSummary:
    return _run_quotation_import(db, file, await file.read(), _require_supplier(db, supplier_id))


@router.post("/suppliers/{supplier_id}/images-import", response_model=schemas.ImageImportSummary)
async def import_images(
    supplier_id: int, file: UploadFile = File(...), db: Session = Depends(get_db),
) -> schemas.ImageImportSummary:
    _require_supplier(db, supplier_id)
    return _run_images_import(db, file, await file.read(), supplier_id)
