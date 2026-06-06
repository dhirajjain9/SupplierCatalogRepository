"""Tests for the catalog source_type filter (suppliers vs competitors)."""


def _supplier(client, name, type_="supplier"):
    return client.post("/api/suppliers", json={"name": name, "type": type_}).json()["id"]


def _item(client, sid, name):
    return client.post("/api/catalog-items", json={"supplier_id": sid, "name": name}).json()


def test_source_type_filters_by_supplier_type(client):
    sup = _supplier(client, "Factory A", "supplier")
    ref = _supplier(client, "Brand X", "reference")
    _item(client, sup, "Supplier Widget")
    _item(client, ref, "Competitor Widget")

    sup_items = client.get("/api/catalog-items?source_type=supplier").json()
    ref_items = client.get("/api/catalog-items?source_type=reference").json()

    assert [i["name"] for i in sup_items] == ["Supplier Widget"]
    assert [i["name"] for i in ref_items] == ["Competitor Widget"]
    # No filter still returns everything.
    assert len(client.get("/api/catalog-items").json()) == 2


def test_source_type_combines_with_supplier_id(client):
    sup = _supplier(client, "Factory B", "supplier")
    _item(client, sup, "Only One")
    # supplier_id narrows to the one source regardless of type filter.
    got = client.get(f"/api/catalog-items?supplier_id={sup}&source_type=supplier").json()
    assert [i["name"] for i in got] == ["Only One"]
