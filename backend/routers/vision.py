"""Endpoints for AI vision extraction of image-only catalog pages.

The browser renders each PDF page to a compact image and posts it here one at a
time. We call Claude to extract the products on that page and return them as
JSON; the browser collects results across pages, lets the user review, then
saves via the normal /api/catalog-import/rows endpoint.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.routers import google as gr
from backend.routers import imports as imp
from backend.services import catalog_import, google, pdf_render, vision
from backend.services.storage import store_file

router = APIRouter(prefix="/api/vision", tags=["vision"])


@router.get("/config")
def vision_config() -> dict:
    """Tell the UI whether AI extraction is available (key configured)."""
    return {"enabled": vision.is_configured(), "model": vision.DEFAULT_MODEL}


@router.post("/extract")
async def vision_extract(file: UploadFile = File(...)) -> dict:
    """Extract products from a single catalog page image."""
    data = await file.read()
    media_type = file.content_type or "image/jpeg"
    try:
        return vision.extract_products(data, media_type)
    except vision.VisionNotConfigured as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except Exception as exc:  # surface provider errors as a clean message
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"AI extraction failed: {exc}")


class DrivePageIn(BaseModel):
    driveFileId: str | None = None
    resourceName: str | None = None
    filename: str | None = None
    supplier_name: str | None = None
    type: str | None = None
    page: int = 0  # 0-based page to render + extract + persist


def _vision_row(p: dict, page_no: int) -> catalog_import.ParsedRow:
    attrs = {}
    for k, label in (("specification", "Specification"), ("color", "Color"),
                     ("material", "Material"), ("features", "Features"),
                     ("usage_scenario", "Usage Scenario")):
        if p.get(k):
            attrs[label] = str(p[k])
    attrs["Source Page"] = str(page_no)
    return catalog_import.ParsedRow(
        name=p.get("name") or "Item", category=p.get("category") or None,
        description=p.get("features") or None, attributes=attrs, source_row=page_no,
    )


@router.post("/import-drive-page")
def import_drive_page(payload: DrivePageIn, db: Session = Depends(get_db)) -> dict:
    """Server-side image-PDF import, one page at a time — no browser download.

    Downloads the PDF from Drive (cached in /tmp), renders the requested page,
    runs AI vision, and persists that page's products. The rendered page image is
    stored as the supplier's page photo (the catalog thumbnails fall back to it by
    'Source Page'). Returns the page count so the browser can drive the loop."""
    if not vision.is_configured():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "AI vision isn't configured (set OPENAI_API_KEY or ANTHROPIC_API_KEY).")
    file_id = payload.driveFileId or payload.resourceName or ""
    data = pdf_render.cached_pdf(file_id)
    if data is None:
        try:
            data = google.download_attachment(db, payload.resourceName, payload.driveFileId)
        except google.NotConnected as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc))
        except Exception as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Couldn't download the file: {exc}")
        pdf_render.cache_pdf(file_id, data)

    try:
        n = pdf_render.page_count(data)
    except Exception as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Couldn't read the PDF: {exc}")

    page = payload.page
    if page < 0 or page >= n:
        return {"page_count": n, "products_added": 0, "supplier_id": None}

    try:
        jpeg = pdf_render.render_page_jpeg(data, page)
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Couldn't render page {page + 1}: {exc}")
    try:
        result = vision.extract_products(jpeg, "image/jpeg")
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"AI extraction failed: {exc}")

    products = [p for p in (result.get("products") or []) if p and p.get("name")]
    sup_name = (payload.supplier_name or "").strip() or result.get("supplier_name") \
        or (payload.filename or "Catalog").rsplit(".", 1)[0]
    default, created = imp._form_default_supplier(db, None, sup_name, payload.type)
    # Remember this Drive file as ingested so the picker flags it (page 0 records
    # it even if a page has no products; later pages just refresh the entry).
    gr._remember_imported(db, file_id, payload.filename or "catalog.pdf", len(products))
    if not products or default is None:
        db.commit()
        return {"page_count": n, "products_added": 0, "supplier_id": default.id if default else None}

    rows = [_vision_row(p, page + 1) for p in products]
    summary, _ = imp._persist_catalog(db, rows, [], default, created, source_type=payload.type)
    # Attach a photo to each product: crop it from the page using the AI's box,
    # else fall back to the whole page image — so every item has its own saved photo.
    ids = summary.item_ids or []
    imgs = 0
    for i, p in enumerate(products):
        iid = ids[i] if i < len(ids) else None
        if not iid:
            continue
        crop = pdf_render.crop_jpeg(jpeg, p.get("box")) if p.get("box") else None
        db.add(store_file(crop or jpeg, f"item-{iid}.jpg", "image/jpeg",
                          supplier_id=default.id, catalog_item_id=iid, kind="image"))
        imgs += 1
    db.commit()
    return {"page_count": n, "products_added": summary.items_created + summary.items_updated,
            "images_added": imgs, "supplier_id": default.id}
