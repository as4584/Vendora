"""Resqlo codes: one code per real product, and any store's scan fills it in."""
from decimal import Decimal

import pytest

from app.models.catalog import CatalogBarcode, CatalogProduct
from app.models.inventory import InventoryItem
from app.services import catalog

LEARN = "/api/v1/scan/learn"
LOOKUP = "/api/v1/scan/lookup"
RESOLVE = "/api/v1/scan/resolve"
UPC = "196153282201"
BLACK_CAT = {
    "name": "Jordan 4 Black Cat", "brand": "Jordan", "style_code": "cu1110-010", "size": "US 10",
    "color": "Black", "buy_price": "180", "expected_sell_price": "400", "condition": "new",
}


def _item(db, user, **kw):
    defaults = dict(name="Jordan 4 Black Cat", quantity=1, status="in_stock", buy_price=Decimal("150"))
    defaults.update(kw)
    item = InventoryItem(user_id=user.id, **defaults)
    db.add(item)
    db.flush()
    return item


def test_one_store_teaches_every_store(client, db, auth_headers, second_auth_headers):
    resp = client.post(LEARN, json={"barcode": UPC, "fields": BLACK_CAT}, headers=auth_headers)
    assert resp.status_code == 200, resp.text

    product = db.query(CatalogProduct).one()
    assert (product.style_code, product.size) == ("CU1110-010", "10")
    assert catalog.is_rq_code(product.rq_code) and product.times_confirmed == 1

    hit = client.get(LOOKUP, params={"barcode": "0" + UPC}, headers=second_auth_headers).json()
    assert hit["match"] == "catalog"
    assert hit["fields"]["name"] == "Jordan 4 Black Cat" and hit["fields"]["rq_code"] == product.rq_code
    # Only product facts are shared: never a store's prices or condition.
    assert not {"buy_price", "expected_sell_price", "condition", "platform"} & set(hit["fields"])

    by_code = client.get(LOOKUP, params={"barcode": product.rq_code.lower()}, headers=second_auth_headers).json()
    assert by_code["match"] == "catalog" and by_code["fields"]["size"] == "10"
    missing = client.get(LOOKUP, params={"barcode": "RQ-0000000"}, headers=second_auth_headers).json()
    assert missing["match"] is None


def test_same_product_keeps_one_code_and_gaps_fill(client, db, auth_headers, second_auth_headers):
    client.post(LEARN, json={"barcode": UPC, "fields": {"name": "Black Cat", "style_code": "CU1110-010", "size": "10"}},
                headers=auth_headers)
    client.post(LEARN, json={"barcode": "00196153282201", "fields": {**BLACK_CAT, "name": "Other name"}},
                headers=second_auth_headers)
    product = db.query(CatalogProduct).one()
    assert product.name == "Black Cat" and product.brand == "Jordan" and product.times_confirmed == 2
    assert {b.code for b in db.query(CatalogBarcode)} == {UPC, "00196153282201"}

    # A store-made tag never enters the shared catalog.
    client.post(LEARN, json={"barcode": "STORE-1", "fields": BLACK_CAT}, headers=auth_headers)
    assert db.query(CatalogBarcode).count() == 2
    # No style code -> nothing to key a product on.
    client.post(LEARN, json={"barcode": "123456789012", "fields": {"name": "Mystery"}}, headers=auth_headers)
    assert db.query(CatalogProduct).count() == 1


def test_style_family_falls_back_to_catalog(client, db, auth_headers, second_auth_headers):
    client.post(LEARN, json={"barcode": UPC, "fields": BLACK_CAT}, headers=auth_headers)
    hit = client.get(LOOKUP, params={"barcode": "999999999999", "style_code": "CU1110-010"},
                     headers=second_auth_headers).json()
    assert hit["match"] == "style" and hit["fields"]["name"] == "Jordan 4 Black Cat"
    assert "size" not in hit["fields"] and "rq_code" not in hit["fields"]


def test_scan_resolves_to_my_item_through_the_catalog(client, db, test_user, auth_headers, second_auth_headers):
    client.post(LEARN, json={"barcode": UPC, "fields": BLACK_CAT}, headers=second_auth_headers)
    rq = db.query(CatalogProduct).one().rq_code
    _item(db, test_user, sku="CU1110-010", size="11")
    mine = _item(db, test_user, sku="X", size="10", custom_attributes={"style_code": "cu1110-010"})

    for code in (UPC, rq):
        hit = client.get(RESOLVE, params={"code": code}, headers=auth_headers).json()
        assert hit["matched_by"] == "catalog" and hit["item"]["id"] == str(mine.id)
    mine.size = "9"
    db.flush()
    assert client.get(RESOLVE, params={"code": rq}, headers=auth_headers).json()["item"] is None


def test_assign_code_to_item_and_stats(client, db, test_user, auth_headers, second_auth_headers):
    item = _item(db, test_user, sku="dd1391-100", size="10", upc=UPC, custom_attributes={"brand": "Nike"})
    resp = client.post(f"/api/v1/inventory/{item.id}/rq-code", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    again = client.post(f"/api/v1/inventory/{item.id}/rq-code", headers=auth_headers).json()
    assert again["rq_code"] == body["rq_code"] and body["brand"] == "Nike"

    looked = client.get(f"/api/v1/catalog/{body['rq_code']}", headers=second_auth_headers)
    assert looked.status_code == 200 and looked.json()["style_code"] == "DD1391-100"
    assert client.get(f"/api/v1/catalog/{UPC}", headers=second_auth_headers).json()["rq_code"] == body["rq_code"]
    assert client.get("/api/v1/catalog/RQ-ZZZZZZZ", headers=auth_headers).status_code == 404

    stats = client.get("/api/v1/catalog/stats", headers=auth_headers).json()
    assert stats == {"products": 1, "styles": 1, "barcodes": 1}

    bare = _item(db, test_user, sku=None)
    assert client.post(f"/api/v1/inventory/{bare.id}/rq-code", headers=auth_headers).status_code == 422
    other = client.post(f"/api/v1/inventory/{item.id}/rq-code", headers=second_auth_headers)
    assert other.status_code == 404


def test_imports_grow_the_catalog(client, db, test_user, auth_headers):
    from app.services.scan_memory import remember_items

    item = _item(db, test_user, sku="FQ1759-100", size="9.5", upc="195866000001")
    remember_items(db, test_user.id, [item])
    assert catalog.find(db, "195866000001").size == "9.5"


@pytest.mark.parametrize("code,ok", [("RQ-7F3K9XA", True), ("RQ-7F3K9X", False), ("RQ-7F3K9XI", False), ("XX-7F3K9XA", False)])
def test_code_format(code, ok):
    assert catalog.is_rq_code(code) is ok
    assert catalog.is_rq_code(catalog.new_rq_code())


def test_concurrent_create_returns_existing(db, monkeypatch):
    first = catalog.get_or_create(db, "AA1", "10", "Shoe")
    real_get = catalog._get
    calls = {"n": 0}

    def stale_then_real(*args):
        calls["n"] += 1
        return None if calls["n"] == 1 else real_get(*args)

    monkeypatch.setattr(catalog, "_get", stale_then_real)
    assert catalog.get_or_create(db, "AA1", "10", "Shoe").id == first.id


ADMIN = "/api/v1/catalog/admin"


@pytest.fixture()
def admin_on(monkeypatch, test_user):
    from app.config import settings

    monkeypatch.setattr(settings, "CATALOG_ADMIN_EMAILS", f" other@x.test , {test_user.email.upper()} ")


def test_admin_access_is_off_by_default(client, auth_headers, second_auth_headers, admin_on):
    assert client.get(f"{ADMIN}/access", headers=auth_headers).json() == {"admin": True}
    assert client.get(f"{ADMIN}/access", headers=second_auth_headers).json() == {"admin": False}
    for method, path in [("get", "/products"), ("put", "/products/RQ-0000000"),
                         ("delete", "/products/RQ-0000000"), ("delete", "/barcodes/1")]:
        resp = getattr(client, method)(f"{ADMIN}{path}", headers=second_auth_headers,
                                       **({"json": {"name": "x", "style_code": "y"}} if method == "put" else {}))
        assert resp.status_code == 403


def test_admin_finds_fixes_and_removes_entries(client, db, auth_headers, second_auth_headers, admin_on):
    client.post(LEARN, json={"barcode": UPC, "fields": {**BLACK_CAT, "name": "Jordan 4 Blak Cat"}},
                headers=second_auth_headers)
    client.post(LEARN, json={"barcode": "195866000001",
                             "fields": {"name": "Dunk Panda", "style_code": "DD1391-100", "size": "10"}},
                headers=second_auth_headers)
    black_cat = db.query(CatalogProduct).filter_by(style_code="CU1110-010").one()

    every = client.get(f"{ADMIN}/products", headers=auth_headers).json()
    assert len(every) == 2
    for q in ("blak", UPC, black_cat.rq_code.lower(), "cu1110", "jordan"):
        hits = client.get(f"{ADMIN}/products", params={"q": q}, headers=auth_headers).json()
        assert [h["rq_code"] for h in hits] == [black_cat.rq_code], q
    assert hits[0]["barcodes"] == [UPC]

    fix = {"name": " Jordan 4 Black Cat ", "style_code": "cu1110-010", "size": "10.5", "brand": "Jordan", "color": " "}
    resp = client.put(f"{ADMIN}/products/{black_cat.rq_code}", json=fix, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Jordan 4 Black Cat" and resp.json()["size"] == "10.5"
    assert resp.json()["color"] is None and resp.json()["rq_code"] == black_cat.rq_code

    clash = client.put(f"{ADMIN}/products/{black_cat.rq_code}",
                       json={"name": "x", "style_code": "DD1391-100", "size": "10"}, headers=auth_headers)
    assert clash.status_code == 409
    assert client.put(f"{ADMIN}/products/RQ-0000000", json=fix, headers=auth_headers).status_code == 404

    assert client.delete(f"{ADMIN}/barcodes/{UPC}", headers=auth_headers).status_code == 204
    assert client.delete(f"{ADMIN}/barcodes/{UPC}", headers=auth_headers).status_code == 404
    assert client.get(LOOKUP, params={"barcode": UPC}, headers=auth_headers).json()["match"] is None

    assert client.delete(f"{ADMIN}/products/{black_cat.rq_code}", headers=auth_headers).status_code == 204
    assert client.delete(f"{ADMIN}/products/{black_cat.rq_code}", headers=auth_headers).status_code == 404
    assert db.query(CatalogProduct).count() == 1
