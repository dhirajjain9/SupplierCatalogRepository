"""End-to-end API tests covering suppliers, catalog items, quotes and documents."""
import io


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_supplier_crud(client):
    # Create
    r = client.post("/api/suppliers", json={"name": "Acme Co", "category": "Hardware"})
    assert r.status_code == 201
    sid = r.json()["id"]
    assert r.json()["name"] == "Acme Co"

    # List + search
    assert len(client.get("/api/suppliers").json()) == 1
    assert len(client.get("/api/suppliers?search=acme").json()) == 1
    assert len(client.get("/api/suppliers?search=zzz").json()) == 0

    # Get
    assert client.get(f"/api/suppliers/{sid}").json()["category"] == "Hardware"

    # Update
    r = client.put(f"/api/suppliers/{sid}", json={"phone": "555-1234"})
    assert r.json()["phone"] == "555-1234"
    assert r.json()["name"] == "Acme Co"  # unchanged

    # Delete
    assert client.delete(f"/api/suppliers/{sid}").status_code == 204
    assert client.get(f"/api/suppliers/{sid}").status_code == 404


def test_supplier_validation(client):
    assert client.post("/api/suppliers", json={}).status_code == 422


def _make_supplier(client, name="S1"):
    return client.post("/api/suppliers", json={"name": name}).json()["id"]


def test_catalog_item_crud_and_fk(client):
    sid = _make_supplier(client)

    # FK validation
    bad = client.post("/api/catalog-items", json={"name": "X", "supplier_id": 999})
    assert bad.status_code == 400

    r = client.post(
        "/api/catalog-items",
        json={"name": "Widget", "sku": "W-1", "supplier_id": sid, "unit": "each"},
    )
    assert r.status_code == 201
    iid = r.json()["id"]

    # Filter by supplier + search
    assert len(client.get(f"/api/catalog-items?supplier_id={sid}").json()) == 1
    assert len(client.get("/api/catalog-items?search=widg").json()) == 1
    assert len(client.get("/api/catalog-items?search=W-1").json()) == 1

    # Update
    r = client.put(f"/api/catalog-items/{iid}", json={"name": "Widget Pro"})
    assert r.json()["name"] == "Widget Pro"

    assert client.delete(f"/api/catalog-items/{iid}").status_code == 204


def test_quote_crud_and_fk(client):
    sid = _make_supplier(client)
    iid = client.post(
        "/api/catalog-items", json={"name": "Bolt", "supplier_id": sid}
    ).json()["id"]

    assert client.post("/api/quotes", json={"unit_price": 1, "catalog_item_id": 999}).status_code == 400

    r = client.post(
        "/api/quotes",
        json={
            "catalog_item_id": iid,
            "unit_price": 2.5,
            "currency": "EUR",
            "min_quantity": 100,
            "valid_from": "2026-01-01",
        },
    )
    assert r.status_code == 201
    qid = r.json()["id"]
    assert r.json()["currency"] == "EUR"

    assert len(client.get(f"/api/quotes?catalog_item_id={iid}").json()) == 1

    r = client.put(f"/api/quotes/{qid}", json={"unit_price": 3.0})
    assert r.json()["unit_price"] == 3.0

    assert client.delete(f"/api/quotes/{qid}").status_code == 204


def test_quote_price_validation(client):
    sid = _make_supplier(client)
    iid = client.post("/api/catalog-items", json={"name": "B", "supplier_id": sid}).json()["id"]
    bad = client.post("/api/quotes", json={"catalog_item_id": iid, "unit_price": -5})
    assert bad.status_code == 422


def test_document_upload_download_delete(client):
    sid = _make_supplier(client)

    # Must attach to something
    r = client.post(
        "/api/documents", files={"file": ("a.txt", b"hi", "text/plain")}
    )
    assert r.status_code == 400

    content = b"catalog pdf bytes"
    r = client.post(
        "/api/documents",
        files={"file": ("catalog.pdf", io.BytesIO(content), "application/pdf")},
        data={"supplier_id": str(sid)},
    )
    assert r.status_code == 201
    doc = r.json()
    assert doc["size_bytes"] == len(content)
    assert doc["supplier_id"] == sid

    # List filtered by supplier
    assert len(client.get(f"/api/documents?supplier_id={sid}").json()) == 1

    # Download returns the bytes
    dl = client.get(f"/api/documents/{doc['id']}/download")
    assert dl.status_code == 200
    assert dl.content == content

    # Delete
    assert client.delete(f"/api/documents/{doc['id']}").status_code == 204
    assert client.get(f"/api/documents/{doc['id']}/download").status_code == 404


def test_cascade_delete(client):
    """Deleting a supplier removes its items and quotes."""
    sid = _make_supplier(client)
    iid = client.post("/api/catalog-items", json={"name": "C", "supplier_id": sid}).json()["id"]
    client.post("/api/quotes", json={"catalog_item_id": iid, "unit_price": 1})

    client.delete(f"/api/suppliers/{sid}")
    assert client.get("/api/catalog-items").json() == []
    assert client.get("/api/quotes").json() == []
