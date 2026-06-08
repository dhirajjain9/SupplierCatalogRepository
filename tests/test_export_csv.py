"""Tests for the taxonomy / products CSV exports."""


def _supplier(client, name="ExpSup"):
    return client.post("/api/suppliers", json={"name": name}).json()["id"]


def _item(client, sid, **kw):
    return client.post("/api/catalog-items", json={"supplier_id": sid, **kw}).json()


def test_taxonomy_and_products_export(client):
    sid = _supplier(client)
    a = _item(client, sid, name="Wok", sku="K-1")
    _item(client, sid, name="Frying Pan", sku="K-2")
    _item(client, sid, name="Loose End")  # no SKU, no category
    # Classify two of them (master/sub), leave the third bare.
    client.put("/api/taxonomy/save", json={"items": [
        {"id": a["id"], "master_category": "Kitchen & Dining", "sub_category": "Cookware"},
    ]})

    tax = client.get("/api/export/taxonomy.csv")
    assert tax.status_code == 200
    assert "attachment; filename=\"taxonomy.csv\"" in tax.headers.get("content-disposition", "")
    lines = tax.text.strip().splitlines()
    assert lines[0] == "Category,Sub-Category"
    assert "Kitchen & Dining,Cookware" in lines           # the one in-use pair
    assert len(lines) == 2                                  # header + one distinct pair

    prod = client.get("/api/export/products.csv")
    assert prod.status_code == 200
    plines = prod.text.strip().splitlines()
    assert plines[0] == "Product/SKU ID,Name,Category,Sub-Category"
    assert "K-1,Wok,Kitchen & Dining,Cookware" in prod.text   # SKU used as id
    assert any(line.startswith("K-2,Frying Pan,,") for line in plines)  # unclassified → blank cats
    # Item without a SKU falls back to its numeric id.
    assert any(",Loose End,," in line for line in plines)
