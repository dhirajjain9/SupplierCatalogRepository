#!/usr/bin/env python3
"""Write taxonomy.csv and products.csv to the repo root from the catalog database.

To export the LIVE catalog, point it at the production database first:

    DATABASE_URL='postgresql://USER:PASS@HOST/DB' python scripts/export_csv.py

(Use the same connection string Vercel exposes as POSTGRES_URL / DATABASE_URL —
copy it from Vercel → Storage → your Postgres → .env tab.) With no env var set,
it uses the local SQLite dev database.
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from backend.database import SessionLocal, init_db  # noqa: E402
from backend.services import export_csv  # noqa: E402


def main() -> None:
    init_db()  # ensure tables exist (no-op if already there)
    with SessionLocal() as db:
        tax = export_csv.taxonomy_csv(db)
        prod = export_csv.products_csv(db)
    with open(os.path.join(ROOT, "taxonomy.csv"), "w", newline="", encoding="utf-8") as f:
        f.write(tax)
    with open(os.path.join(ROOT, "products.csv"), "w", newline="", encoding="utf-8") as f:
        f.write(prod)
    tax_rows = max(0, tax.count("\n") - 1)
    prod_rows = max(0, prod.count("\n") - 1)
    print(f"Wrote taxonomy.csv ({tax_rows} pairs) and products.csv ({prod_rows} products) to {ROOT}")


if __name__ == "__main__":
    main()
