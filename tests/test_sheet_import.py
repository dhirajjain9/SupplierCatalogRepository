"""Tests for Google Sheet import (network fetch stubbed)."""
from backend.routers import imports as imp


def test_sheet_csv_url_normalization():
    u = imp._sheet_csv_url("https://docs.google.com/spreadsheets/d/ABC123/edit#gid=42")
    assert u == "https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=42"
    u2 = imp._sheet_csv_url("https://docs.google.com/spreadsheets/d/XYZ/edit")
    assert u2.endswith("export?format=csv&gid=0")


def test_sheet_import_creates_reference_brand(client, monkeypatch):
    csv = (b"Name,SKU,Category\nCeramic Mug,M-1,Drinkware\nGlass Jar,J-1,Storage\n")
    monkeypatch.setattr(imp, "_fetch_google_sheet", lambda url, tab=None: csv)
    r = client.post("/api/sheet-import", json={
        "url": "https://docs.google.com/spreadsheets/d/ABC/edit",
        "supplier_name": "Flying Tiger", "type": "reference",
    }).json()
    assert r["items_created"] == 2
    refs = client.get("/api/suppliers?type=reference").json()
    assert [s["name"] for s in refs] == ["Flying Tiger"]


def test_sheet_import_brand_column_creates_reference_brands(client, monkeypatch):
    # A single sheet with a Brand column + type=reference => each brand becomes a
    # reference (competitor), not a supplier.
    csv = (b"Brand,Name,SKU\nHomeEss,Mug,M1\nNesasia,Vase,V1\nHomeEss,Plate,P1\n")
    monkeypatch.setattr(imp, "_fetch_google_sheet", lambda url, tab=None: csv)
    r = client.post("/api/sheet-import", json={
        "url": "https://docs.google.com/spreadsheets/d/ABC/edit", "type": "reference",
    }).json()
    assert r["items_created"] == 3
    assert r["suppliers_created"] == 2
    refs = {s["name"] for s in client.get("/api/suppliers?type=reference").json()}
    assert refs == {"HomeEss", "Nesasia"}
    assert client.get("/api/suppliers?type=supplier").json() == []


def test_sheet_import_rejects_private_sheet(client, monkeypatch):
    from fastapi import HTTPException
    def boom(url, tab=None):
        raise HTTPException(400, "This sheet isn't publicly accessible.")
    monkeypatch.setattr(imp, "_fetch_google_sheet", boom)
    r = client.post("/api/sheet-import", json={"url": "https://docs.google.com/spreadsheets/d/X/edit",
                                               "supplier_name": "X", "type": "reference"})
    assert r.status_code == 400

