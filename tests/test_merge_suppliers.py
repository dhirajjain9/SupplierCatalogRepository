"""Tests for merging suppliers into one."""


def _supplier(client, name, type_="supplier"):
    return client.post("/api/suppliers", json={"name": name, "type": type_}).json()["id"]


def _item(client, sid, name):
    return client.post("/api/catalog-items", json={"supplier_id": sid, "name": name}).json()["id"]


def _items_of(client, sid):
    return client.get(f"/api/catalog-items?supplier_id={sid}").json()


def test_merge_into_new_target_moves_items_and_deletes_sources(client):
    a = _supplier(client, "Circle A")
    b = _supplier(client, "Circle B")
    c = _supplier(client, "Circle C")
    _item(client, a, "Mug")
    _item(client, b, "Plate")
    _item(client, c, "Bowl")

    r = client.post("/api/maintenance/merge-suppliers",
                    json={"source_ids": [a, b, c], "target_name": "CIRCLE"}).json()
    assert r["merged"] == 3
    assert r["items_moved"] == 3
    target = r["target_id"]

    # Sources are gone; the three items now live under CIRCLE.
    sups = {s["name"] for s in client.get("/api/suppliers?type=supplier").json()}
    assert sups == {"CIRCLE"}
    names = sorted(i["name"] for i in _items_of(client, target))
    assert names == ["Bowl", "Mug", "Plate"]


def test_merge_into_existing_target_keeps_it(client):
    keep = _supplier(client, "CIRCLE")
    dup = _supplier(client, "Circle Trading")
    _item(client, keep, "Existing")
    _item(client, dup, "Moved")

    r = client.post("/api/maintenance/merge-suppliers",
                    json={"source_ids": [keep, dup], "target_name": "circle"}).json()
    # 'circle' resolves to the existing CIRCLE (case-insensitive); only dup merges in.
    assert r["target_id"] == keep
    assert r["merged"] == 1
    names = sorted(i["name"] for i in _items_of(client, keep))
    assert names == ["Existing", "Moved"]
    assert len(client.get("/api/suppliers?type=supplier").json()) == 1


def test_merge_requires_a_target(client):
    a = _supplier(client, "X")
    r = client.post("/api/maintenance/merge-suppliers", json={"source_ids": [a]})
    assert r.status_code == 400
