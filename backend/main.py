"""Application entry point for the Supplier Catalog Repository.

Run with:  uvicorn backend.main:app --reload
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.database import init_db
from backend.routers import catalog, documents, quotes, suppliers

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


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


@app.get("/api/health", tags=["health"])
def health() -> dict[str, str]:
    return {"status": "ok"}


# Serve the single-page frontend. Mounted last so /api/* routes take priority.
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
