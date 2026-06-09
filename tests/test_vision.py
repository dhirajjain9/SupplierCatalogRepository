"""Tests for AI vision extraction plumbing (the model call itself is stubbed)."""
from backend.services import vision


def test_parse_json_plain():
    out = vision._parse_json('{"page_type":"product","products":[{"name":"Cloth"}]}')
    assert out["products"][0]["name"] == "Cloth"


def test_parse_json_fenced_and_prose():
    text = 'Here you go:\n```json\n{"products":[{"name":"Towel"}]}\n```\nThanks!'
    out = vision._parse_json(text)
    assert out["products"][0]["name"] == "Towel"
    assert out["page_type"] == "product"   # defaulted


def test_parse_json_garbage_is_safe():
    out = vision._parse_json("the model said something weird")
    assert out["products"] == []


def test_config_endpoint_reports_disabled_without_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.get("/api/vision/config").json()
    assert r["enabled"] is False
    assert "model" in r


def test_extract_endpoint_without_key_is_clear_error(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.post("/api/vision/extract",
                    files={"file": ("page.jpg", b"\xff\xd8\xff", "image/jpeg")})
    assert r.status_code == 400
    assert "ANTHROPIC_API_KEY" in r.json()["detail"]


def test_extract_endpoint_returns_products(client, monkeypatch):
    # Stub the Claude call so we can test the endpoint end-to-end offline.
    def fake_extract(data, media_type="image/jpeg", model=None):
        return {"page_type": "product", "supplier_name": "Suzhou Better Clean",
                "products": [{"name": "3M Cloth", "material": "80%Polyester/20%Nylon",
                              "features": "Mirror cleaning"}]}
    monkeypatch.setattr(vision, "extract_products", fake_extract)
    r = client.post("/api/vision/extract",
                    files={"file": ("page.jpg", b"\xff\xd8\xff", "image/jpeg")}).json()
    assert r["supplier_name"] == "Suzhou Better Clean"
    assert r["products"][0]["name"] == "3M Cloth"


def test_import_drive_page_requires_ai_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    r = client.post("/api/vision/import-drive-page", json={"driveFileId": "abc", "page": 0})
    assert r.status_code == 400
