"""Tests for attaching product images referenced by URL in catalog columns."""
import io


def _supplier(client, name="URLSup"):
    return client.post("/api/suppliers", json={"name": name}).json()["id"]


def _png_bytes(color=(10, 120, 200)):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buf, format="PNG")
    return buf.getvalue()


def _import(client, sid, csv):
    return client.post(
        f"/api/suppliers/{sid}/catalog-import",
        files={"file": ("c.csv", csv.encode(), "text/csv")},
    ).json()


def _images(client, item_id):
    return client.get(f"/api/documents?catalog_item_id={item_id}&kind=image").json()


def test_image_url_in_image_column_is_fetched_and_attached(client, monkeypatch):
    from backend.services import image_urls

    monkeypatch.setattr(image_urls, "_http_get", lambda url: _png_bytes())
    sid = _supplier(client)
    r = _import(client, sid, "Name,SKU,Image\nWidget,W-1,http://example.com/w1.png\n")
    assert r["images_attached"] == 1

    item = client.get(f"/api/catalog-items?supplier_id={sid}").json()[0]
    docs = _images(client, item["id"])
    assert len(docs) == 1
    assert docs[0]["content_type"] == "image/jpeg"  # downscaled to JPEG


def test_non_image_url_columns_are_ignored(client, monkeypatch):
    from backend.services import image_urls

    called = {"n": 0}

    def _fake_get(url):
        called["n"] += 1
        return _png_bytes()

    monkeypatch.setattr(image_urls, "_http_get", _fake_get)
    sid = _supplier(client, "NoImgSup")
    # "Alibaba Link" / "PI Document URL" are URLs but not image columns.
    r = _import(
        client, sid,
        "Name,SKU,Alibaba Link,PI Document URL\n"
        "Widget,W-1,http://example.com/p.html,http://example.com/pi.pdf\n",
    )
    assert r["images_attached"] == 0
    assert called["n"] == 0


def test_multiple_image_columns_and_dedupe(client, monkeypatch):
    from backend.services import image_urls

    monkeypatch.setattr(image_urls, "_http_get", lambda url: _png_bytes())
    sid = _supplier(client, "MultiSup")
    r = _import(
        client, sid,
        "Name,SKU,Display Image,Image 2,Image 3\n"
        "Widget,W-1,http://x/a.png,http://x/b.png,http://x/a.png\n",  # a.png repeated
    )
    item = client.get(f"/api/catalog-items?supplier_id={sid}").json()[0]
    # a.png + b.png → 2 distinct images (the duplicate is de-duplicated).
    assert r["images_attached"] == 2
    assert len(_images(client, item["id"])) == 2


def test_reimport_does_not_duplicate_url_images(client, monkeypatch):
    from backend.services import image_urls

    monkeypatch.setattr(image_urls, "_http_get", lambda url: _png_bytes())
    sid = _supplier(client, "IdemSup")
    csv = "Name,SKU,Image\nWidget,W-1,http://example.com/w1.png\n"
    assert _import(client, sid, csv)["images_attached"] == 1
    # Second import of the same row should attach nothing (item already has an image).
    assert _import(client, sid, csv)["images_attached"] == 0
    item = client.get(f"/api/catalog-items?supplier_id={sid}").json()[0]
    assert len(_images(client, item["id"])) == 1


def test_unreachable_url_is_skipped_silently(client, monkeypatch):
    from backend.services import image_urls

    def _boom(url):
        raise OSError("network down")

    monkeypatch.setattr(image_urls, "_http_get", _boom)
    sid = _supplier(client, "DeadSup")
    r = _import(client, sid, "Name,SKU,Image\nWidget,W-1,http://example.com/dead.png\n")
    assert r["images_attached"] == 0  # non-fatal: row still imported
    assert r["items_created"] == 1


def test_drive_id_extraction():
    from backend.services import image_urls

    assert image_urls.drive_file_id("https://drive.google.com/uc?id=ABC1234567xyz") == "ABC1234567xyz"
    assert image_urls.drive_file_id("https://drive.google.com/file/d/ABC1234567xyz/view") == "ABC1234567xyz"
    assert image_urls.drive_file_id("https://example.com/photo.png?id=short") is None
    assert image_urls.drive_file_id("https://example.com/photo.png") is None
