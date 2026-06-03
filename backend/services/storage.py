"""Build Document rows that carry their file bytes in the database.

Storing uploads in the database (rather than on local disk) keeps the app
stateless, so it runs on serverless hosts like Vercel where the filesystem is
ephemeral and shared state must live in the managed Postgres database. The
document upload endpoint and the bulk image importer share this one helper.
"""
from __future__ import annotations

from backend import models


def store_file(
    contents: bytes,
    filename: str,
    content_type: str | None = None,
    *,
    supplier_id: int | None = None,
    catalog_item_id: int | None = None,
    kind: str = "document",
) -> models.Document:
    """Return an un-persisted Document holding the file bytes.

    The caller adds it to the session and commits.
    """
    return models.Document(
        supplier_id=supplier_id,
        catalog_item_id=catalog_item_id,
        filename=filename or "file",
        content_type=content_type,
        size_bytes=len(contents),
        kind=kind,
        data=contents,
    )
