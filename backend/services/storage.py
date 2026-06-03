"""Shared on-disk storage for uploaded files (documents and product images).

Files live under ``data/uploads`` with a collision-proof generated name; the
``documents`` table keeps the metadata. Centralizing this here lets the document
upload endpoint and the bulk image importer share one code path.
"""
from __future__ import annotations

import os
import uuid

from backend import models

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", os.path.join(BASE_DIR, "data", "uploads"))


def store_file(
    contents: bytes,
    filename: str,
    content_type: str | None = None,
    *,
    supplier_id: int | None = None,
    catalog_item_id: int | None = None,
    kind: str = "document",
) -> models.Document:
    """Write ``contents`` to the upload dir and return an un-persisted Document.

    The caller is responsible for adding it to the session and committing.
    """
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}_{os.path.basename(filename or 'file')}"
    with open(os.path.join(UPLOAD_DIR, stored_name), "wb") as fh:
        fh.write(contents)
    return models.Document(
        supplier_id=supplier_id,
        catalog_item_id=catalog_item_id,
        filename=filename or stored_name,
        content_type=content_type,
        size_bytes=len(contents),
        kind=kind,
        stored_name=stored_name,
    )
