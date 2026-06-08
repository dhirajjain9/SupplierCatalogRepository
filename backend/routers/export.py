"""CSV export endpoints: download the taxonomy and the product/category mapping."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.services import export_csv

router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("/taxonomy.csv", response_class=PlainTextResponse)
def export_taxonomy(db: Session = Depends(get_db)) -> PlainTextResponse:
    return PlainTextResponse(
        export_csv.taxonomy_csv(db), media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="taxonomy.csv"'},
    )


@router.get("/products.csv", response_class=PlainTextResponse)
def export_products(db: Session = Depends(get_db)) -> PlainTextResponse:
    return PlainTextResponse(
        export_csv.products_csv(db), media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="products.csv"'},
    )
