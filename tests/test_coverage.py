"""Tests for the competitive-coverage backend (taxonomy/classify; AI stubbed)."""
from backend.services import taxonomy


def test_supplier_type_roundtrip(client):
    r = client.post("/api/suppliers", json={"name": "Flying Tiger", "type": "reference"}).json()
    assert r["type"] == "reference"
    # default stays supplier
    s = client.post("/api/suppliers", json={"name": "Shenzhen Co"}).json()
    assert s["type"] == "supplier"
    # filter by type
    refs = client.get("/api/suppliers?type=reference").json()
    assert [x["name"] for x in refs] == ["Flying Tiger"]


def test_classify_save_sets_categories(client):
    sid = client.post("/api/suppliers", json={"name": "Acme"}).json()["id"]
    iid = client.post("/api/catalog-items", json={"name": "Frying Pan", "supplier_id": sid}).json()["id"]
    r = client.put("/api/taxonomy/save", json={"items": [
        {"id": iid, "master_category": "Kitchen", "sub_category": "Cookware"}]}).json()
    assert r["updated"] == 1
    item = client.get(f"/api/catalog-items/{iid}").json()
    assert item["master_category"] == "Kitchen"
    assert item["sub_category"] == "Cookware"


def test_stats_and_master_sub_filters(client):
    sid = client.post("/api/suppliers", json={"name": "Acme"}).json()["id"]
    a = client.post("/api/catalog-items", json={"name": "Pan", "supplier_id": sid}).json()["id"]
    b = client.post("/api/catalog-items", json={"name": "Mug", "supplier_id": sid}).json()["id"]
    client.put("/api/taxonomy/save", json={"items": [
        {"id": a, "master_category": "Kitchen", "sub_category": "Cookware"},
        {"id": b, "master_category": "Kitchen", "sub_category": "Drinkware"},
    ]})
    stats = client.get("/api/catalog-items/stats").json()
    kitchen = [r for r in stats if r["master_category"] == "Kitchen"]
    assert sum(r["count"] for r in kitchen) == 2
    # filters
    assert len(client.get("/api/catalog-items?master_category=Kitchen").json()) == 2
    assert len(client.get("/api/catalog-items?sub_category=Cookware").json()) == 1


def test_taxonomy_config_disabled_without_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert client.get("/api/taxonomy/config").json()["enabled"] is False


def test_classify_endpoint_stubbed(client, monkeypatch):
    monkeypatch.setattr(taxonomy, "classify_items",
                        lambda items, tax, model=None: [{"id": items[0]["id"], "master_category": "Kitchen", "sub_category": "Cookware"}])
    r = client.post("/api/taxonomy/classify", json={
        "taxonomy": {"categories": []},
        "items": [{"id": 1, "name": "Wok", "category": None}]}).json()
    assert r["items"][0]["sub_category"] == "Cookware"
