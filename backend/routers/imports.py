"""Bulk catalog import: upload a CSV/XLSX/PDF price list for a supplier.

Each parsed row becomes (or updates) a CatalogItem. Rows that carry a price also
record a Quote, giving a simple price history across re-imports. Items are
matched on (supplier_id, sku) so re-uploading an updated list updates in place
rather than creating duplicates; rows without a SKU are always inserted.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend import models, schemas
from backend.database import get_db
from backend.services import catalog_import

router = APIRouter(prefix="/api", tags=["import"])


@router.get("/catalog-import/template", response_class=PlainTextResponse)
def download_template() -> PlainTextResponse:
    """Return a CSV template suppliers/users can fill in and re-upload."""
    return PlainTextResponse(
        catalog_import.template_csv(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="catalog-template.csv"'},
    )


@router.post(
    "/suppliers/{supplier_id}/catalog-import",
    response_model=schemas.ImportSummary,
)
async def import_catalog(
    supplier_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> schemas.ImportSummary:
    supplier = db.get(models.Supplier, supplier_id)
    if supplier is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Supplier not found")

    data = await file.read()
    try:
        result = catalog_import.parse_catalog_file(file.filename or "", file.content_type, data)
    except catalog_import.UnsupportedFileType as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    items_created = items_updated = quotes_created = 0

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
        db.flush()  # ensure item.id is available for the quote

        if row.has_price:
            db.add(
                models.Quote(
                    catalog_item_id=item.id,
                    unit_price=row.unit_price,
                    currency=row.currency,
                    min_quantity=row.min_quantity,
                )
            )
            quotes_created += 1

    db.commit()

    return schemas.ImportSummary(
        supplier_id=supplier_id,
        rows_parsed=len(result.rows),
        items_created=items_created,
        items_updated=items_updated,
        quotes_created=quotes_created,
        rows_failed=len(result.errors),
        errors=[schemas.ImportError(**e) for e in result.errors],
    )
