"""Application entry point for the Supplier Catalog Repository.

Run with:  uvicorn backend.main:app --reload
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.database import get_db, init_db
from backend.routers import (
    analysis, catalog, documents, export, google, imports, maintenance, quotes, suppliers, translate, vision,
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")


import logging


def _safe_init_db() -> None:
    """Initialize the schema, but never let a transient DB issue crash the whole
    app at import (which would 500 every route, even static pages). If it fails,
    we degrade: static pages/health still serve and DB calls retry per request."""
    try:
        init_db()
    except Exception:
        logging.exception("init_db failed; continuing without it")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _safe_init_db()
    yield


# Some serverless runtimes (e.g. Vercel) don't run ASGI lifespan events, so also
# initialize the schema at import time. Wrapped so a DB blip can't take the app down.
_safe_init_db()


app = FastAPI(
    title="Supplier Catalog Repository",
    description="Manage suppliers, their catalog items, price quotes and documents.",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(suppliers.router)
app.include_router(catalog.router)
app.include_router(quotes.router)
app.include_router(documents.router)
app.include_router(imports.router)
app.include_router(vision.router)
app.include_router(analysis.router)
app.include_router(google.router)
app.include_router(translate.router)
app.include_router(maintenance.router)
app.include_router(export.router)


@app.get("/api/health", tags=["health"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/counts", tags=["health"])
def counts(db=Depends(get_db)) -> dict[str, int]:
    """Cheap row counts for the nav badges (avoids pulling full lists)."""
    from sqlalchemy import func, select
    from backend import models
    by_type = dict(db.execute(
        select(models.Supplier.type, func.count()).group_by(models.Supplier.type)
    ).all())
    one = lambda m: db.scalar(select(func.count()).select_from(m))
    return {
        "suppliers": sum(n for t, n in by_type.items() if (t or "supplier") != "reference"),
        "competitors": by_type.get("reference", 0),
        "catalog": one(models.CatalogItem),
        "quotes": one(models.Quote),
        "documents": one(models.Document),
    }


# Serve the single-page frontend. Mounted last so /api/* routes take priority.
if os.path.isdir(FRONTEND_DIR):
    # Make the browser/CDN revalidate the frontend assets on every load (cheap via
    # ETag → 304 when unchanged) so a new deploy shows up immediately instead of a
    # stale cached app.js/styles.css.
    @app.middleware("http")
    async def _revalidate_frontend(request, call_next):
        resp = await call_next(request)
        path = request.url.path
        if path == "/" or path == "/favicon.ico" or path.startswith("/static/"):
            resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp

    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    @app.get("/favicon.ico", include_in_schema=False)
    def favicon() -> FileResponse:
        return FileResponse(os.path.join(FRONTEND_DIR, "favicon.svg"), media_type="image/svg+xml")
