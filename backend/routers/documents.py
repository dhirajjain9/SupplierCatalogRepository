"""Endpoints for uploading, listing and downloading documents/attachments.

Files are stored on disk under ``data/uploads`` with a generated unique name,
while metadata lives in the ``documents`` table. A document may be attached to a
supplier, a catalog item, or both.
"""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend import models, schemas
from backend.database import get_db
from backend.services.storage import UPLOAD_DIR, store_file

router = APIRouter(prefix="/api/documents", tags=["documents"])


def _get_or_404(db: Session, document_id: int) -> models.Document:
    doc = db.get(models.Document, document_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")
    return doc


@router.get("", response_model=list[schemas.DocumentOut])
def list_documents(
    db: Session = Depends(get_db),
    supplier_id: int | None = Query(default=None),
    catalog_item_id: int | None = Query(default=None),
    kind: str | None = Query(default=None, description="Filter by 'document' or 'image'"),
) -> list[models.Document]:
    stmt = select(models.Document).order_by(models.Document.uploaded_at.desc())
    if supplier_id is not None:
        stmt = stmt.where(models.Document.supplier_id == supplier_id)
    if catalog_item_id is not None:
        stmt = stmt.where(models.Document.catalog_item_id == catalog_item_id)
    if kind is not None:
        stmt = stmt.where(models.Document.kind == kind)
    return list(db.scalars(stmt).all())


@router.post("", response_model=schemas.DocumentOut, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    supplier_id: int | None = Form(default=None),
    catalog_item_id: int | None = Form(default=None),
    db: Session = Depends(get_db),
) -> models.Document:
    if supplier_id is None and catalog_item_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "A document must be attached to a supplier and/or a catalog item",
        )
    if supplier_id is not None and db.get(models.Supplier, supplier_id) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "supplier_id does not exist")
    if catalog_item_id is not None and db.get(models.CatalogItem, catalog_item_id) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "catalog_item_id does not exist")

    contents = await file.read()
    doc = store_file(
        contents,
        file.filename or "file",
        file.content_type,
        supplier_id=supplier_id,
        catalog_item_id=catalog_item_id,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


@router.get("/{document_id}/download")
def download_document(document_id: int, db: Session = Depends(get_db)) -> FileResponse:
    doc = _get_or_404(db, document_id)
    path = os.path.join(UPLOAD_DIR, doc.stored_name)
    if not os.path.exists(path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File data missing on server")
    return FileResponse(
        path,
        media_type=doc.content_type or "application/octet-stream",
        filename=doc.filename,
    )


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(document_id: int, db: Session = Depends(get_db)) -> None:
    doc = _get_or_404(db, document_id)
    path = os.path.join(UPLOAD_DIR, doc.stored_name)
    if os.path.exists(path):
        os.remove(path)
    db.delete(doc)
    db.commit()
