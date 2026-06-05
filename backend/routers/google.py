"""OAuth + Google Chat browse/import endpoints (single-user owner integration)."""
from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend import schemas
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
    summary, _ = imp._persist_catalog(db, result.rows, result.warnings, default, created, source_type=payload.type)
    db.commit()
    return summary
