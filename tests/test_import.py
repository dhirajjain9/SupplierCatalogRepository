"""Tests for catalog import: parsing (CSV/XLSX/PDF), validation and the endpoint."""
import io

from backend.services import catalog_import as ci


# --------------------------------------------------------------------------- #
# Unit tests: header mapping + validation (format-agnostic)
# --------------------------------------------------------------------------- #
def test_header_aliases_map_to_canonical():
    assert ci.canonical_header("Product Name") == "name"
    assert ci.canonical_header("MOQ") == "min_quantity"
    assert ci.canonical_header("Part No.") == "sku"
    assert ci.canonical_header("Unknown Column") is None


def test_normalize_rows_validates_and_coerces():
    headers = ["Name", "SKU", "Price", "Currency", "Min Qty", "Type"]
    rows = [
        ["Widget", "W1", "$1,234.50", "eur", "100", "Hardware"],  # ok, messy price/ccy
        ["", "W2", "5", "USD", "1", "Hardware"],                  # missing name
        ["Gadget", "G1", "notanumber", "USD", "1", "Tools"],      # bad price
        ["Gizmo", "G2", "9.99", "US", "1", "Tools"],              # bad currency
        ["Sprocket", "S1", "3.00", "USD", "0", "Tools"],          # bad min qty
        ["Cog", "C1", "", "", "", "Tools"],                        # ok, no price
    ]
    result = ci.normalize_rows(headers, rows)

    assert len(result.rows) == 2
    widget = result.rows[0]
    assert widget.name == "Widget"
    assert widget.unit_price == 1234.5
    assert widget.currency == "EUR"
    assert widget.min_quantity == 100
    assert widget.category == "Hardware"
    assert widget.has_price

    cog = result.rows[1]
    assert cog.name == "Cog"
    assert cog.has_price is False

    failed_rows = {e["row"] for e in result.errors}
    assert failed_rows == {3, 4, 5, 6}


def test_normalize_rows_requires_name_column():
    result = ci.normalize_rows(["Foo", "Bar"], [["a", "b"]])
    assert result.rows == []
    assert "Name" in result.errors[0]["error"]


def test_parse_csv_roundtrip():
    csv_bytes = ci.template_csv().encode()
    result = ci.parse_catalog_file("catalog.csv", "text/csv", csv_bytes)
    assert len(result.rows) == 1
    assert result.rows[0].name == "Resistor 10k"
    assert result.rows[0].unit_price == 0.05


def test_parse_xlsx():
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Name", "SKU", "Unit Price", "Category"])
    ws.append(["Capacitor", "C-100", 0.02, "Passives"])
    ws.append(["Inductor", "L-100", 0.10, "Passives"])
    buf = io.BytesIO()
    wb.save(buf)

    result = ci.parse_catalog_file("catalog.xlsx", None, buf.getvalue())
    assert len(result.rows) == 2
    assert {r.name for r in result.rows} == {"Capacitor", "Inductor"}


def test_parse_pdf_with_table():
    pdf_bytes = _make_pdf_with_table(
        ["Name", "SKU", "Unit Price", "Category"],
        [["Diode", "D-1", "0.03", "Semis"], ["Transistor", "T-1", "0.08", "Semis"]],
    )
    result = ci.parse_catalog_file("catalog.pdf", "application/pdf", pdf_bytes)
    names = {r.name for r in result.rows}
    assert "Diode" in names and "Transistor" in names


def test_unsupported_file_type():
    import pytest

    with pytest.raises(ci.UnsupportedFileType):
        ci.parse_catalog_file("catalog.docx", None, b"x")


# --------------------------------------------------------------------------- #
# Endpoint tests
# --------------------------------------------------------------------------- #
def _make_supplier(client, name="ImpSup"):
    return client.post("/api/suppliers", json={"name": name}).json()["id"]


def test_import_endpoint_creates_items_and_quotes(client):
    sid = _make_supplier(client)
    csv_data = (
        "Name,SKU,Unit Price,Currency,Min Qty,Category\n"
        "Bolt M3,B-M3,0.10,USD,500,Fasteners\n"
        "Nut M3,N-M3,0.05,USD,500,Fasteners\n"
        "Washer,,,,,Fasteners\n"  # no price -> item only, no quote
    )
    r = client.post(
        f"/api/suppliers/{sid}/catalog-import",
        files={"file": ("list.csv", csv_data.encode(), "text/csv")},
    )
    assert r.status_code == 200
    s = r.json()
    assert s["items_created"] == 3
    assert s["quotes_created"] == 2
    assert s["rows_failed"] == 0

    # Items now searchable and category filterable.
    assert len(client.get(f"/api/catalog-items?supplier_id={sid}").json()) == 3
    assert "Fasteners" in client.get("/api/catalog-items/categories").json()


def test_import_upserts_on_sku(client):
    sid = _make_supplier(client)
    first = "Name,SKU,Unit Price\nWidget,W1,1.00\n"
    client.post(
        f"/api/suppliers/{sid}/catalog-import",
        files={"file": ("a.csv", first.encode(), "text/csv")},
    )
    # Re-import same SKU with a new name/price -> update item, add a 2nd quote.
    second = "Name,SKU,Unit Price\nWidget Pro,W1,1.50\n"
    r = client.post(
        f"/api/suppliers/{sid}/catalog-import",
        files={"file": ("b.csv", second.encode(), "text/csv")},
    ).json()
    assert r["items_created"] == 0
    assert r["items_updated"] == 1

    items = client.get(f"/api/catalog-items?supplier_id={sid}").json()
    assert len(items) == 1
    assert items[0]["name"] == "Widget Pro"
    # Two quotes recorded for the one item (price history).
    assert len(client.get(f"/api/quotes?catalog_item_id={items[0]['id']}").json()) == 2


def test_import_reports_row_errors(client):
    sid = _make_supplier(client)
    csv_data = "Name,Unit Price\nGood,1.00\nBad,abc\n"
    r = client.post(
        f"/api/suppliers/{sid}/catalog-import",
        files={"file": ("c.csv", csv_data.encode(), "text/csv")},
    ).json()
    assert r["items_created"] == 1
    assert r["rows_failed"] == 1
    assert r["errors"][0]["row"] == 3


def test_import_unknown_supplier_404(client):
    r = client.post(
        "/api/suppliers/999/catalog-import",
        files={"file": ("c.csv", b"Name\nX\n", "text/csv")},
    )
    assert r.status_code == 404


def test_template_download(client):
    r = client.get("/api/catalog-import/template")
    assert r.status_code == 200
    assert "Name" in r.text and "Unit Price" in r.text


# --------------------------------------------------------------------------- #
# Search enhancements
# --------------------------------------------------------------------------- #
def test_search_by_description_and_category(client):
    sid = _make_supplier(client)
    client.post("/api/catalog-items", json={
        "name": "Alpha", "supplier_id": sid, "category": "Tools",
        "description": "ergonomic handle",
    })
    client.post("/api/catalog-items", json={
        "name": "Beta", "supplier_id": sid, "category": "Parts",
        "description": "stainless",
    })
    # Description substring match.
    assert len(client.get("/api/catalog-items?search=ergonomic").json()) == 1
    # Category facet.
    assert len(client.get("/api/catalog-items?category=Tools").json()) == 1
    # Categories endpoint lists both.
    cats = client.get("/api/catalog-items/categories").json()
    assert set(cats) == {"Parts", "Tools"}


# --------------------------------------------------------------------------- #
# Helper: build a simple PDF containing a table
# --------------------------------------------------------------------------- #
def _make_pdf_with_table(headers, rows):
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate, Table

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter)
    doc.build([Table([headers] + rows)])
    return buf.getvalue()
