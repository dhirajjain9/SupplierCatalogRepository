"""Bulk import endpoints for a supplier's catalog, quotations and images.

Step 1 — catalog import (CSV/XLSX/PDF): each parsed row becomes (or updates) a
CatalogItem, matched on (supplier_id, sku). Every original column is preserved
in ``attributes``. Rows that already carry a price also record a Quote, and
images embedded in an .xlsx are attached to their row's item.

Step 2 — quotation import: a later price list is matched to existing items by
SKU and its price/MOQ are recorded as Quotes (price history), without touching
the catalog itself.

Images — a zip of photos (or a single image) is matched to items by the SKU in
each file name and stored as image documents for marketing collateral.
"""
from __future__ import annotations

import zipfile

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend import models, schemas
from backend.database import get_db
from backend.services import catalog_import, images
from backend.services.storage import store_file

router = APIRouter(prefix="/api", tags=["import"])


def _require_supplier(db: Session, supplier_id: int) -> models.Supplier:
    supplier = db.get(models.Supplier, supplier_id)
    if supplier is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Supplier not found")
    return supplier


def _parse_or_400(file: UploadFile, data: bytes) -> catalog_import.ImportResult:
    try:
        return catalog_import.parse_catalog_file(file.filename or "", file.content_type, data)
    except catalog_import.UnsupportedFileType as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.get("/catalog-import/template", response_class=PlainTextResponse)
def download_template() -> PlainTextResponse:
    """Return a CSV template suppliers/users can fill in and re-upload."""
    return PlainTextResponse(
        catalog_import.template_csv(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="catalog-template.csv"'},
    )


@router.post("/suppliers/{supplier_id}/catalog-import", response_model=schemas.ImportSummary)
async def import_catalog(
    supplier_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> schemas.ImportSummary:
    _require_supplier(db, supplier_id)
    data = await file.read()
    result = _parse_or_400(file, data)

    items_created = items_updated = quotes_created = 0
    row_to_item: dict[int, models.CatalogItem] = {}

    for row in result.rows:
        item = None
        if row.sku:
            item = db.scalar(
                select(models.CatalogItem).where(
                    models.CatalogItem.supplier_id == supplier_id,
                    models.CatalogItem.sku == row.sku,
                )
            )
        if item is None:
            item = models.CatalogItem(supplier_id=supplier_id, name=row.name, sku=row.sku)
            db.add(item)
            items_created += 1
        else:
            item.name = row.name
            items_updated += 1

        item.unit = row.unit
        item.category = row.category
        item.description = row.description
        item.attributes = row.attributes  # full original row, every column
        db.flush()  # ensure item.id is available
        row_to_item[row.source_row] = item

        if row.has_price:
            db.add(models.Quote(
                catalog_item_id=item.id, unit_price=row.unit_price,
                currency=row.currency, min_quantity=row.min_quantity,
            ))
            quotes_created += 1

    # Attach images embedded in an .xlsx to their row's item (matched by SKU
    # via the anchor row).
    images_attached = 0
    if (file.filename or "").lower().endswith(".xlsx"):
        for img in images.extract_xlsx_images(data):
            item = row_to_item.get(img.source_row or -1)
            if item is None:
                continue
            db.add(store_file(
                img.data, img.filename, img.content_type,
                supplier_id=supplier_id, catalog_item_id=item.id, kind="image",
            ))
            images_attached += 1

    db.commit()

    return schemas.ImportSummary(
        supplier_id=supplier_id,
        rows_captured=len(result.rows),
        items_created=items_created,
        items_updated=items_updated,
        quotes_created=quotes_created,
        images_attached=images_attached,
        rows_with_warnings=len(result.warnings),
        warnings=[schemas.ImportWarning(**w) for w in result.warnings],
    )


@router.post("/suppliers/{supplier_id}/quotation-import", response_model=schemas.QuotationSummary)
async def import_quotation(
    supplier_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> schemas.QuotationSummary:
    """Attach prices/MOQ from a quotation to existing catalog items (by SKU)."""
    _require_supplier(db, supplier_id)
    data = await file.read()
    result = _parse_or_400(file, data)

    quotes_created = rows_unmatched = rows_without_price = 0
    matched_items: set[int] = set()
    warnings = list(result.warnings)

    for row in result.rows:
        if not row.sku:
            rows_unmatched += 1
            warnings.append({"row": row.source_row, "warning": "No SKU; cannot match to catalog"})
            continue
        item = db.scalar(
            select(models.CatalogItem).where(
                models.CatalogItem.supplier_id == supplier_id,
                models.CatalogItem.sku == row.sku,
            )
        )
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

    db.commit()

    return schemas.QuotationSummary(
        supplier_id=supplier_id,
        quotes_created=quotes_created,
        items_matched=len(matched_items),
        rows_unmatched=rows_unmatched,
        rows_without_price=rows_without_price,
        warnings=[schemas.ImportWarning(**w) for w in warnings],
    )


@router.post("/suppliers/{supplier_id}/images-import", response_model=schemas.ImageImportSummary)
async def import_images(
    supplier_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> schemas.ImageImportSummary:
    """Match product images to catalog items by the SKU in each file name.

    Accepts a .zip of images or a single image file.
    """
    _require_supplier(db, supplier_id)
    data = await file.read()
    name = (file.filename or "").lower()

    if name.endswith(".zip"):
        extracted = images.extract_zip_images(data)
        # Report non-image entries that were skipped.
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
            supplier_id=supplier_id, catalog_item_id=item.id, kind="image",
        ))
        stored += 1
    db.commit()

    return schemas.ImageImportSummary(
        supplier_id=supplier_id,
        images_stored=stored,
        images_unmatched=unmatched,
        files_skipped=skipped,
    )


def _find_item_for_image(db: Session, supplier_id: int, filename: str) -> models.CatalogItem | None:
    for sku in images.sku_candidates(filename):
        item = db.scalar(
            select(models.CatalogItem).where(
                models.CatalogItem.supplier_id == supplier_id,
                models.CatalogItem.sku == sku,
            )
        )
        if item is not None:
            return item
    return None


def _zip_non_images(data: bytes) -> list[str]:
    import io

    skipped: list[str] = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            base = info.filename.rsplit("/", 1)[-1]
            if info.is_dir() or base.startswith("."):
                continue
            if not images.is_image(info.filename):
                skipped.append(base)
    return skipped
