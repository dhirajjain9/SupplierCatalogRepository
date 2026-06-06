"""Tests for the post-import maintenance endpoints (image de-dupe + report)."""
import io


def _supplier(client, name="MSup"):
    return client.post("/api/suppliers", json={"name": name}).json()["id"]


def _png(color=(1, 2, 3)):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buf, format="PNG")
    return buf.getvalue()


def _item(client, sid, name="Widget", sku="W-1"):
    return client.post("/api/catalog-items", json={"supplier_id": sid, "name": name, "sku": sku}).json()["id"]


def _attach(client, item_id, data, fname="p.png"):
    return client.post(
        "/api/documents",
        files={"file": (fname, data, "image/png")},
        data={"catalog_item_id": str(item_id)},
    )


def _images(client, item_id):
    return client.get(f"/api/documents?catalog_item_id={item_id}&kind=image").json()


def test_dedupe_removes_identical_images_keeps_one(client):
    sid = _supplier(client)
    item = _item(client, sid)
    same = _png((10, 20, 30))
    _attach(client, item, same)
    _attach(client, item, same)      # exact duplicate
    _attach(client, item, same)      # and another
    _attach(client, item, _png((99, 99, 99)))  # a different photo — must survive
    assert len(_images(client, item)) == 4

    rep = client.get("/api/maintenance/duplicates").json()
    assert rep["duplicate_images"]["removable"] == 2

    r = client.post("/api/maintenance/dedupe-images", json={}).json()
    assert r["removed"] == 2
    # One copy of the duplicated photo + the distinct photo remain.
    assert len(_images(client, item)) == 2
    # Idempotent: running again removes nothing.
    assert client.post("/api/maintenance/dedupe-images", json={}).json()["removed"] == 0


def test_same_image_on_different_items_is_not_deduped(client):
    sid = _supplier(client)
    a, b = _item(client, sid, "A", "A-1"), _item(client, sid, "B", "B-1")
    shared = _png((5, 5, 5))
    _attach(client, a, shared)
    _attach(client, b, shared)  # same bytes, different item — legitimately distinct
    assert client.post("/api/maintenance/dedupe-images", json={}).json()["removed"] == 0
    assert len(_images(client, a)) == 1 and len(_images(client, b)) == 1


def test_duplicate_suppliers_reported(client):
    _supplier(client, "Acme Co")
    _supplier(client, "  acme co ")  # same name, different case/whitespace
    _supplier(client, "Other")
    rep = client.get("/api/maintenance/duplicates").json()
    dups = rep["duplicate_suppliers"]
    assert any(d["count"] == 2 for d in dups)
    assert all(d["name"].strip().lower() != "other" for d in dups)
