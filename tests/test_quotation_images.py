"""Tests for the two-step quotation import and SKU-matched image import."""
import io
import zipfile

from backend.services import images


def _supplier(client, name="QSup"):
    return client.post("/api/suppliers", json={"name": name}).json()["id"]


def _import_catalog(client, sid, csv):
    return client.post(
        f"/api/suppliers/{sid}/catalog-import",
        files={"file": ("cat.csv", csv.encode(), "text/csv")},
    ).json()


def _png_bytes(color=(10, 120, 200)):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buf, format="PNG")
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# Step 2: quotation import
# --------------------------------------------------------------------------- #
def test_quotation_attaches_quotes_to_existing_items(client):
    sid = _supplier(client)
    # Step 1: basic catalog, no prices.
    _import_catalog(client, sid, "Name,SKU,Category\nBolt,B-1,Fasteners\nNut,N-1,Fasteners\n")
    items = client.get(f"/api/catalog-items?supplier_id={sid}").json()
    assert all(  # no quotes yet
        len(client.get(f"/api/quotes?catalog_item_id={i['id']}").json()) == 0 for i in items
    )

    # Step 2: quotation with price + MOQ for known + unknown SKUs.
    quote_csv = (
        "SKU,Unit Price,MOQ,Currency\n"
        "B-1,0.10,500,USD\n"      # matches
        "N-1,0.05,1000,USD\n"     # matches
        "X-9,9.99,1,USD\n"        # unknown SKU
        "B-1,,,\n"                # matched but no price
    )
    r = client.post(
        f"/api/suppliers/{sid}/quotation-import",
        files={"file": ("q.csv", quote_csv.encode(), "text/csv")},
    ).json()

    assert r["quotes_created"] == 2
    assert r["items_matched"] == 2
    assert r["rows_unmatched"] == 1
    assert r["rows_without_price"] == 1

    bolt = next(i for i in items if i["sku"] == "B-1")
    quotes = client.get(f"/api/quotes?catalog_item_id={bolt['id']}").json()
    assert len(quotes) == 1
    assert quotes[0]["unit_price"] == 0.10
    assert quotes[0]["min_quantity"] == 500


# --------------------------------------------------------------------------- #
# Image import by SKU
# --------------------------------------------------------------------------- #
def test_image_zip_matched_by_sku(client):
    sid = _supplier(client)
    _import_catalog(client, sid, "Name,SKU\nBolt,B-1\nNut,N-1\n")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("B-1.png", _png_bytes())
        zf.writestr("B-1_2.png", _png_bytes((5, 5, 5)))  # second photo, same SKU
        zf.writestr("N-1.jpg", _png_bytes((9, 9, 9)))
        zf.writestr("UNKNOWN.png", _png_bytes())          # no matching SKU
        zf.writestr("readme.txt", b"not an image")        # skipped

    r = client.post(
        f"/api/suppliers/{sid}/images-import",
        files={"file": ("imgs.zip", buf.getvalue(), "application/zip")},
    ).json()

    assert r["images_stored"] == 3
    assert r["images_unmatched"] == ["UNKNOWN.png"]
    assert r["files_skipped"] == ["readme.txt"]

    # Bolt should now have two image documents attached.
    bolt = next(i for i in client.get(f"/api/catalog-items?supplier_id={sid}").json()
                if i["sku"] == "B-1")
    imgs = client.get(f"/api/documents?catalog_item_id={bolt['id']}&kind=image").json()
    assert len(imgs) == 2
    assert all(d["kind"] == "image" for d in imgs)


def test_single_image_upload(client):
    sid = _supplier(client)
    _import_catalog(client, sid, "Name,SKU\nWidget,W-1\n")
    r = client.post(
        f"/api/suppliers/{sid}/images-import",
        files={"file": ("W-1.png", _png_bytes(), "image/png")},
    ).json()
    assert r["images_stored"] == 1


def test_embedded_xlsx_images_attached_on_catalog_import(client):
    import openpyxl
    from openpyxl.drawing.image import Image as XLImage

    sid = _supplier(client)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Name", "SKU"])
    ws.append(["Widget", "W-1"])
    ws.append(["Gadget", "G-1"])
    ws.add_image(XLImage(io.BytesIO(_png_bytes())), "C2")  # row 2 -> Widget
    out = io.BytesIO()
    wb.save(out)

    r = client.post(
        f"/api/suppliers/{sid}/catalog-import",
        files={"file": ("cat.xlsx", out.getvalue(),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    ).json()
    assert r["items_created"] == 2
    assert r["images_attached"] == 1

    widget = next(i for i in client.get(f"/api/catalog-items?supplier_id={sid}").json()
                  if i["sku"] == "W-1")
    assert len(client.get(f"/api/documents?catalog_item_id={widget['id']}&kind=image").json()) == 1


def test_image_import_rejects_non_image(client):
    sid = _supplier(client)
    r = client.post(
        f"/api/suppliers/{sid}/images-import",
        files={"file": ("spec.pdf", b"%PDF-1.4", "application/pdf")},
    )
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# Unit: SKU-from-filename
# --------------------------------------------------------------------------- #
def test_sku_candidates():
    assert images.sku_candidates("BH-01.jpg") == ["BH-01"]
    assert images.sku_candidates("BH-01_2.png") == ["BH-01_2", "BH-01"]
    assert images.sku_candidates("path/to/ABC-9.JPEG") == ["ABC-9"]
