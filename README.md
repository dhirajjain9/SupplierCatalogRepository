# SupplierCatalogRepository

A full-stack web application for managing supplier catalogs and quotes — store
your suppliers, the items they offer, price quotes for those items, and related
documents (catalog PDFs, spec sheets, etc.) all in one place.

## Features

- **Suppliers** — create, edit, search and delete supplier records (contact,
  email, phone, address, category, notes).
- **Catalog items** — track the products/items each supplier offers (name, SKU,
  unit, category, description), linked to their supplier.
- **Quotes** — record price quotes per catalog item, with currency, minimum
  quantity and validity dates.
- **Documents** — upload and download file attachments (e.g. catalog PDFs)
  associated with a supplier and/or a catalog item.
- Cascading deletes keep data consistent (deleting a supplier removes its items,
  quotes and documents).
- Interactive API docs at `/docs` (Swagger UI).

## Tech stack

| Layer    | Technology                                  |
|----------|---------------------------------------------|
| Backend  | Python 3.11+, FastAPI, SQLAlchemy 2.0       |
| Database | SQLite (file-based, zero config)            |
| Frontend | Vanilla HTML/CSS/JS single-page app (no build step) |
| Tests    | pytest + FastAPI TestClient                 |

The frontend is served directly by FastAPI, so there is **no separate build or
node toolchain** — one command starts the whole app.

## Getting started

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Run the app (creates ./data/catalog.db on first start)
./run.sh
#   ...or directly:
python3 -m uvicorn backend.main:app --reload
```

Then open <http://127.0.0.1:8000> for the UI, or
<http://127.0.0.1:8000/docs> for the interactive API documentation.

## Running tests

```bash
python3 -m pytest
```

Tests run against an isolated in-memory database and a temporary upload
directory, so they never touch your real data.

## Project layout

```
backend/
  main.py            FastAPI app; wires routers and serves the frontend
  database.py        Engine, session and Base declaration
  models.py          SQLAlchemy ORM models (Supplier, CatalogItem, Quote, Document)
  schemas.py         Pydantic request/response schemas
  routers/
    suppliers.py     /api/suppliers      CRUD
    catalog.py       /api/catalog-items  CRUD
    quotes.py        /api/quotes         CRUD
    documents.py     /api/documents      upload / download / delete
frontend/
  index.html         Single-page UI shell
  styles.css         Styling
  app.js             Client logic (tabs, tables, modal forms, fetch calls)
tests/
  conftest.py        Test fixtures (isolated DB + client)
  test_api.py        End-to-end API tests
data/                Runtime data (SQLite DB + uploaded files; git-ignored)
```

## Configuration

Environment variables (all optional):

| Variable       | Default                  | Purpose                          |
|----------------|--------------------------|----------------------------------|
| `DATABASE_URL` | `sqlite:///data/catalog.db` | SQLAlchemy database URL       |
| `UPLOAD_DIR`   | `data/uploads`           | Where uploaded files are stored  |
| `PORT`         | `8000`                   | Port used by `run.sh`            |

## API overview

| Method | Path                              | Description                  |
|--------|-----------------------------------|------------------------------|
| GET    | `/api/suppliers`                  | List/search suppliers        |
| POST   | `/api/suppliers`                  | Create a supplier            |
| GET/PUT/DELETE | `/api/suppliers/{id}`     | Get / update / delete        |
| GET    | `/api/catalog-items`              | List/filter catalog items    |
| POST   | `/api/catalog-items`              | Create an item               |
| GET/PUT/DELETE | `/api/catalog-items/{id}` | Get / update / delete        |
| GET    | `/api/quotes`                     | List/filter quotes           |
| POST   | `/api/quotes`                     | Create a quote               |
| GET/PUT/DELETE | `/api/quotes/{id}`        | Get / update / delete        |
| GET    | `/api/documents`                  | List/filter documents        |
| POST   | `/api/documents`                  | Upload a document (multipart)|
| GET    | `/api/documents/{id}/download`    | Download a document          |
| DELETE | `/api/documents/{id}`             | Delete a document            |
