"""Store barcodes: seller rules and linked codes make any scan resolvable."""
from decimal import Decimal

from app.models.barcode import BarcodeRule
from app.models.inventory import InventoryItem
from app.services import barcode_rules as br

RESOLVE = "/api/v1/scan/resolve"
RULES = "/api/v1/scan/rules"


def _item(db, user, **kw):
    defaults = dict(name="Jordan 4 Black Cat", quantity=1, status="in_stock", buy_price=Decimal("150"))
    defaults.update(kw)
    item = InventoryItem(user_id=user.id, **defaults)
    db.add(item)
    db.flush()
    return item


def _resolve(client, headers, code):
    resp = client.get(RESOLVE, params={"code": code}, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_unknown_store_code_misses_then_links(client, db, test_user, auth_headers):
    item = _item(db, test_user, sku="J4-BC-10")
    assert _resolve(client, auth_headers, "STORE-889921")["item"] is None

    resp = client.post(f"/api/v1/inventory/{item.id}/barcodes", json={"code": " store-889921 "}, headers=auth_headers)
    assert resp.status_code == 201, resp.text
    hit = _resolve(client, auth_headers, "STORE-889921")
    assert hit["item"]["id"] == str(item.id) and hit["matched_by"] == "linked"

    listed = client.get(f"/api/v1/inventory/{item.id}/barcodes", headers=auth_headers).json()
    assert [link["code"] for link in listed] == ["STORE-889921"]
    assert client.delete(f"/api/v1/inventory/{item.id}/barcodes/store-889921", headers=auth_headers).status_code == 204
    assert _resolve(client, auth_headers, "STORE-889921")["item"] is None
    assert client.delete(f"/api/v1/inventory/{item.id}/barcodes/store-889921", headers=auth_headers).status_code == 404


def test_sku_and_upc_match_without_rules(client, db, test_user, auth_headers):
    item = _item(db, test_user, sku="dz5485-612", upc="196153282201")
    assert _resolve(client, auth_headers, "DZ5485-612")["matched_by"] == "sku"
    assert _resolve(client, auth_headers, "0196153282201")["item"]["id"] == str(item.id)


def test_in_stock_item_wins_over_sold_out(client, db, test_user, auth_headers):
    _item(db, test_user, sku="DUP", quantity=0, status="sold")
    live = _item(db, test_user, sku="DUP", quantity=2)
    assert _resolve(client, auth_headers, "DUP")["item"]["id"] == str(live.id)


def test_rule_strips_prefix_and_slices(client, db, test_user, auth_headers):
    item = _item(db, test_user, sku="12345")
    rule = {"name": "Shelf tags", "prefix": "sk", "suffix": "/A", "slice_start": 1, "slice_length": 5,
            "lookup_field": "sku"}
    resp = client.post(RULES, json=rule, headers=auth_headers)
    assert resp.status_code == 201, resp.text
    hit = _resolve(client, auth_headers, "SK1234599/A")
    assert hit["item"]["id"] == str(item.id)
    assert hit["rule_name"] == "Shelf tags" and hit["code"] == "12345"


def test_rule_order_and_crud(client, db, test_user, auth_headers):
    a = client.post(RULES, json={"name": "A", "min_length": 3}, headers=auth_headers).json()
    b = client.post(RULES, json={"name": "B", "prefix": "X"}, headers=auth_headers).json()
    assert [r["name"] for r in client.get(RULES, headers=auth_headers).json()] == ["A", "B"]
    ordered = client.post(f"{RULES}/order", json={"ids": [b["id"], a["id"]]}, headers=auth_headers).json()
    assert [r["name"] for r in ordered] == ["B", "A"]
    assert client.post(f"{RULES}/order", json={"ids": [a["id"]]}, headers=auth_headers).status_code == 400

    upd = client.put(f"{RULES}/{a['id']}", json={"name": "A2", "suffix": "z", "enabled": False}, headers=auth_headers)
    assert upd.status_code == 200 and upd.json()["suffix"] == "Z" and upd.json()["enabled"] is False
    assert client.delete(f"{RULES}/{a['id']}", headers=auth_headers).status_code == 204
    assert client.put(f"{RULES}/{a['id']}", json={"name": "x", "prefix": "Q"}, headers=auth_headers).status_code == 404


def test_rule_validation(client, auth_headers):
    assert client.post(RULES, json={"name": "Everything"}, headers=auth_headers).status_code == 422
    bad = {"name": "Len", "min_length": 9, "max_length": 3}
    assert client.post(RULES, json=bad, headers=auth_headers).status_code == 422


def test_rule_limit(client, db, test_user, auth_headers, monkeypatch):
    from app.routers import barcodes
    monkeypatch.setattr(barcodes, "MAX_RULES", 1)
    assert client.post(RULES, json={"name": "1", "prefix": "A"}, headers=auth_headers).status_code == 201
    assert client.post(RULES, json={"name": "2", "prefix": "B"}, headers=auth_headers).status_code == 409


def test_link_conflicts_replace_and_limit(client, db, test_user, auth_headers, monkeypatch):
    first = _item(db, test_user, name="First")
    second = _item(db, test_user, name="Second")
    url = "/api/v1/inventory/{}/barcodes"
    assert client.post(url.format(first.id), json={"code": "TAG1"}, headers=auth_headers).status_code == 201
    assert client.post(url.format(first.id), json={"code": "TAG1"}, headers=auth_headers).status_code == 201
    clash = client.post(url.format(second.id), json={"code": "TAG1"}, headers=auth_headers)
    assert clash.status_code == 409 and "First" in clash.json()["detail"]
    moved = client.post(url.format(second.id), json={"code": "TAG1", "replace": True}, headers=auth_headers)
    assert moved.json()["inventory_item_id"] == str(second.id)
    assert client.post(url.format(second.id), json={"code": "   "}, headers=auth_headers).status_code == 422

    from app.routers import barcodes
    monkeypatch.setattr(barcodes, "MAX_LINKS_PER_ITEM", 1)
    assert client.post(url.format(second.id), json={"code": "TAG2"}, headers=auth_headers).status_code == 409


def test_label_qr_resolves(client, db, test_user, auth_headers):
    item = _item(db, test_user)
    assert _resolve(client, auth_headers, f"resqlo:item:{item.id}")["matched_by"] == "label"
    assert _resolve(client, auth_headers, "resqlo:item:not-a-uuid")["item"] is None


def test_deleted_item_links_do_not_resolve(client, db, test_user, auth_headers):
    from datetime import datetime, timezone
    item = _item(db, test_user)
    client.post(f"/api/v1/inventory/{item.id}/barcodes", json={"code": "GONE"}, headers=auth_headers)
    item.deleted_at = datetime.now(timezone.utc)
    db.flush()
    assert _resolve(client, auth_headers, "GONE")["item"] is None


def test_other_users_codes_are_invisible(client, db, test_user, auth_headers, second_auth_headers):
    item = _item(db, test_user, sku="PRIVATE-1")
    client.post(f"/api/v1/inventory/{item.id}/barcodes", json={"code": "MINE"}, headers=auth_headers)
    assert _resolve(client, second_auth_headers, "MINE")["item"] is None
    assert _resolve(client, second_auth_headers, "PRIVATE-1")["item"] is None


def test_rule_engine_units():
    rule = BarcodeRule(name="r", prefix="AB", suffix=None, strip_prefix=False, strip_suffix=True,
                       slice_start=None, slice_length=3, enabled=True, min_length=None, max_length=None)
    assert br.rule_matches(rule, "ABCDEF") and br.apply_rule(rule, "ABCDEF") == "ABC"
    rule.enabled = False
    assert not br.rule_matches(rule, "ABCDEF")
    length_only = BarcodeRule(name="len", min_length=4, max_length=6, enabled=True, prefix=None, suffix=None)
    assert br.rule_matches(length_only, "1234") and not br.rule_matches(length_only, "123")
    assert not br.rule_matches(length_only, "1234567")
    suffix = BarcodeRule(name="s", suffix="X", enabled=True, prefix=None, min_length=None, max_length=None)
    assert not br.rule_matches(suffix, "ABC")
    empty = BarcodeRule(name="e", enabled=True, prefix=None, suffix=None, min_length=None, max_length=None)
    assert not br.rule_matches(empty, "ABC")
    assert br.clean_code(" ab\tc\n") == "ABC"
    assert br.upc_variants("ABC") == {"ABC"}
