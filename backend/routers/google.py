"""OAuth + Google Chat browse/import endpoints (single-user owner integration)."""
from __future__ import annotations

import datetime as _dt
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend import models, schemas
from backend.database import get_db
from backend.routers import imports as imp
from backend.services import catalog_import, google

router = APIRouter(prefix="/api", tags=["google"])


def _redirect_uri(request: Request) -> str:
    # A fixed GOOGLE_REDIRECT_URI (if set) avoids any host/scheme drift behind
    # Vercel; otherwise derive it from the request's external host.
    import os
    fixed = os.environ.get("GOOGLE_REDIRECT_URI")
    if fixed:
        return fixed
    base = str(request.base_url).rstrip("/").replace("http://", "https://")
    return f"{base}/api/google/callback"


@router.get("/google/status")
def google_status(db: Session = Depends(get_db)) -> dict:
    return google.status(db)


@router.get("/google/connect")
def google_connect(request: Request) -> RedirectResponse:
    try:
        url = google.auth_url(_redirect_uri(request), state=secrets.token_urlsafe(16))
    except google.NotConfigured as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return RedirectResponse(url)


@router.get("/google/callback")
def google_callback(request: Request, code: str | None = None, error: str | None = None,
                    db: Session = Depends(get_db)) -> RedirectResponse:
    if error or not code:
        return RedirectResponse("/?chat=error")
    try:
        google.exchange_code(code, _redirect_uri(request), db)
    except Exception:
        return RedirectResponse("/?chat=error")
    return RedirectResponse("/?chat=connected")


@router.get("/chat/spaces")
def chat_spaces(db: Session = Depends(get_db)) -> list[dict]:
    try:
        return google.list_spaces(db)
    except google.NotConnected as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc))
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Chat API error: {exc}")


@router.get("/chat/files")
def chat_files(space: str, db: Session = Depends(get_db)) -> list[dict]:
    try:
        return google.list_attachments(db, space)
    except google.NotConnected as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc))
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Chat API error: {exc}")


_CT_BY_EXT = {
    "pdf": "application/pdf",
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
}


# Per-chunk download size. Kept well under Vercel's ~4.5 MB serverless response
# cap so arbitrarily large attachments can be pulled in slices by the browser.
_CHAT_CHUNK = 3 * 1024 * 1024


@router.get("/chat/download")
def chat_download(filename: str = "file", resourceName: str | None = None,
                  driveFileId: str | None = None, offset: int = 0, length: int = 0,
                  db: Session = Depends(get_db)) -> Response:
    """Serve one byte-range slice of a Chat attachment so the browser can pull large
    files in chunks (no single response exceeds the serverless size limit) and run
    them through the same client-side AI vision / text pipeline as direct uploads."""
    if length <= 0 or length > _CHAT_CHUNK:
        length = _CHAT_CHUNK
    offset = max(0, offset)
    try:
        data, total = google.download_attachment_range(db, resourceName, driveFileId, offset, length)
    except google.NotConnected as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc))
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Couldn't download the file: {exc}")
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return Response(content=data, media_type=_CT_BY_EXT.get(ext, "application/octet-stream"),
                    headers={"X-Total-Size": str(total),
                             "Access-Control-Expose-Headers": "X-Total-Size"})


@router.get("/drive/folders")
def drive_folders(db: Session = Depends(get_db)) -> list[dict]:
    try:
        return google.list_drive_folders(db)
    except google.NotConnected as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc))
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Drive API error: {exc}")


@router.get("/drive/files")
def drive_files(folder: str, db: Session = Depends(get_db)) -> list[dict]:
    folder_id = google.folder_id_from_link(folder)
    if not folder_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Couldn't read that folder link/id.")
    try:
        return google.list_drive_files(db, folder_id)
    except google.NotConnected as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc))
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Drive API error: {exc}")


class ChatImport(BaseModel):
    filename: str
    resourceName: str | None = None
    driveFileId: str | None = None
    supplier_id: int | None = None
    supplier_name: str | None = None
    type: str | None = None


@router.post("/chat/import", response_model=schemas.ImportSummary)
def chat_import(payload: ChatImport, db: Session = Depends(get_db)) -> schemas.ImportSummary:
    """Download a catalog attachment from Chat and run it through the importer."""
    try:
        data = google.download_attachment(db, payload.resourceName, payload.driveFileId)
    except google.NotConnected as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc))
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Couldn't download the file: {exc}")

    name = payload.filename or "catalog.csv"
    try:
        result = catalog_import.parse_catalog_file(name, None, data)
    except catalog_import.UnsupportedFileType as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    if not result.rows:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "No rows found. If this is an image-only PDF, import it via the Catalog "
            "tab (AI extraction); the Chat importer handles CSV/Excel/text PDFs.",
        )
    default, created = imp._form_default_supplier(db, payload.supplier_id, payload.supplier_name, payload.type)
    summary, row_to_item = imp._persist_catalog(db, result.rows, result.warnings, default, created, source_type=payload.type)
    summary.images_attached += imp._attach_image_urls(db, row_to_item)
    _remember_imported(db, payload.driveFileId or payload.resourceName, name, summary.rows_captured)
    db.commit()
    return summary


def _remember_imported(db: Session, file_id: str | None, filename: str, rows: int) -> None:
    """Record (or refresh) that this external file was imported, so the picker can
    flag it and the user doesn't re-import it by mistake."""
    if not file_id:
        return
    row = db.scalar(select(models.ImportedFile).where(models.ImportedFile.file_id == file_id))
    if row is None:
        db.add(models.ImportedFile(source="drive", file_id=file_id, filename=filename, rows=rows or 0))
    else:
        row.filename, row.rows, row.imported_at = filename, rows or 0, _dt.datetime.utcnow()


@router.get("/drive/imported")
def drive_imported(db: Session = Depends(get_db)) -> list[dict]:
    """File ids already imported (so the picker can mark them)."""
    rows = db.scalars(select(models.ImportedFile)).all()
    return [{"file_id": r.file_id, "filename": r.filename, "rows": r.rows,
             "imported_at": r.imported_at.isoformat() if r.imported_at else None} for r in rows]


class MarkImportedIn(BaseModel):
    files: list[dict] = []  # each: {driveFileId?|resourceName?, filename?}


@router.post("/drive/mark-imported")
def drive_mark_imported(payload: MarkImportedIn, db: Session = Depends(get_db)) -> dict:
    """Manually flag files as already-imported (one-time baseline for catalogs
    ingested before the memory existed) without re-importing them."""
    marked = 0
    for f in payload.files:
        fid = f.get("driveFileId") or f.get("resourceName")
        if not fid:
            continue
        _remember_imported(db, fid, f.get("filename") or "file", 0)
        marked += 1
    db.commit()
    return {"marked": marked}
