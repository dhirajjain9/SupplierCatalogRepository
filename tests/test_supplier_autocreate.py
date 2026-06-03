"""Imports without a pre-created supplier: resolved from the file or the form."""


def _suppliers(client):
    return client.get("/api/suppliers").json()


def test_catalog_import_creates_suppliers_from_file_column(client):
    # No suppliers exist yet; the file names them in a "Supplier" column.
    assert _suppliers(client) == []
    csv_data = (
        "Supplier,Name,SKU,Unit Price\n"
        "Acme Components,Resistor 10k,R10K,0.05\n"
        "Acme Components,Capacitor 1uF,C1U,0.02\n"
        "Globex Hardware,Hex Bolt M8,B-M8,0.10\n"
    )
    r = client.post("/api/catalog-import",
                    files={"file": ("cat.csv", csv_data.encode(), "text/csv")}).json()
    assert r["items_created"] == 3
    assert r["suppliers_created"] == 2
    assert r["quotes_created"] == 3

    names = {s["name"] for s in _suppliers(client)}
    assert names == {"Acme Components", "Globex Hardware"}

    # Items are filed under the right supplier.
    acme = next(s for s in _suppliers(client) if s["name"] == "Acme Components")
    assert len(client.get(f"/api/catalog-items?supplier_id={acme['id']}").json()) == 2


def test_catalog_import_supplier_columns_enrich_contact(client):
    csv_data = (
        "Supplier,Supplier Email,Name,SKU\n"
        "Acme Components,sales@acme.test,Widget,W1\n"
    )
    client.post("/api/catalog-import",
                files={"file": ("c.csv", csv_data.encode(), "text/csv")})
    acme = next(s for s in _suppliers(client) if s["name"] == "Acme Components")
    assert acme["email"] == "sales@acme.test"


def test_catalog_import_supplier_name_from_form(client):
    # File has no supplier column; the supplier name is given in the form instead.
    csv_data = "Name,SKU,Unit Price\nBracket,BR-1,1.25\n"
    r = client.post("/api/catalog-import",
                    files={"file": ("c.csv", csv_data.encode(), "text/csv")},
                    data={"supplier_name": "Fresh Vendor"}).json()
    assert r["items_created"] == 1
    assert r["suppliers_created"] == 1
    assert {s["name"] for s in _suppliers(client)} == {"Fresh Vendor"}


def test_catalog_import_existing_supplier_not_duplicated(client):
    client.post("/api/suppliers", json={"name": "Acme Components"})
    csv_data = "Supplier,Name,SKU\nAcme Components,Widget,W1\nacme components,Gadget,G1\n"
    r = client.post("/api/catalog-import",
                    files={"file": ("c.csv", csv_data.encode(), "text/csv")}).json()
    # Case-insensitive match -> no new suppliers, both items under the one supplier.
    assert r["suppliers_created"] == 0
    assert r["items_created"] == 2
    assert len(_suppliers(client)) == 1


def test_catalog_import_without_any_supplier_is_a_clear_error(client):
    csv_data = "Name,SKU\nWidget,W1\n"
    r = client.post("/api/catalog-import",
                    files={"file": ("c.csv", csv_data.encode(), "text/csv")})
    assert r.status_code == 400
    assert "supplier" in r.json()["detail"].lower()


def test_quotation_import_auto_matches_across_suppliers(client):
    # Seed a catalog (supplier auto-created) then quote by SKU with no supplier given.
    client.post("/api/catalog-import",
                files={"file": ("c.csv",
                                b"Supplier,Name,SKU\nAcme,Bolt,B-1\nAcme,Nut,N-1\n", "text/csv")})
    r = client.post("/api/quotation-import",
                    files={"file": ("q.csv",
                                    b"SKU,Unit Price,MOQ\nB-1,0.10,500\nN-1,0.05,1000\n", "text/csv")}).json()
    assert r["quotes_created"] == 2
    assert r["items_matched"] == 2


def test_images_import_without_supplier_matches_globally(client):
    import io, zipfile
    from PIL import Image

    client.post("/api/catalog-import",
                files={"file": ("c.csv", b"Supplier,Name,SKU\nAcme,Bolt,B-1\n", "text/csv")})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        png = io.BytesIO(); Image.new("RGB", (6, 6), (1, 2, 3)).save(png, "PNG")
        zf.writestr("B-1.png", png.getvalue())
    r = client.post("/api/images-import",
                    files={"file": ("imgs.zip", buf.getvalue(), "application/zip")}).json()
    assert r["images_stored"] == 1
