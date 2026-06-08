"""Build the taxonomy / products CSV exports from the catalog database.

Shared by the download endpoints (backend/routers/export.py) and the
``scripts/export_csv.py`` command, so the format is identical either way.
"""
from __future__ import annotations

import csv
import io

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend import models


def taxonomy_csv(db: Session) -> str:
    """Every distinct (Category, Sub-Category) pair currently in use on items.

    Category = master_category, Sub-Category = sub_category. Only rows that carry
    a master category are included (the curated taxonomy actually in use).
    """
    rows = db.execute(
        select(models.CatalogItem.master_category, models.CatalogItem.sub_category)
        .where(models.CatalogItem.master_category.is_not(None))
        .distinct()
    ).all()
    pairs = sorted({(m, s or "") for (m, s) in rows})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Category", "Sub-Category"])
    w.writerows(pairs)
    return buf.getvalue()


def products_csv(db: Session) -> str:
    """One row per catalog item: id/SKU, name, current master & sub category."""
    items = db.scalars(
        select(models.CatalogItem).order_by(models.CatalogItem.name, models.CatalogItem.id)
    ).all()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Product/SKU ID", "Name", "Category", "Sub-Category"])
    for it in items:
        w.writerow([it.sku or it.id, it.name, it.master_category or "", it.sub_category or ""])
    return buf.getvalue()
