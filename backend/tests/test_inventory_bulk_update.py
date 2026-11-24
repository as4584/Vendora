"""POST /api/v1/inventory/bulk-update — edit many items at once."""
from decimal import Decimal

from app.models.inventory import InventoryItem

URL = "/api/v1/inventory/bulk-update"


def _item(db, user, **kw):
    item = InventoryItem(user_id=user.id, name=kw.pop("name", "Thing"), **kw)
    db.add(item)
    db.flush()
    return item


def test_percent_price_change_and_cost(client, db, test_user, auth_headers):
    a = _item(db, test_user, expected_sell_price=Decimal("100.00"))
    b = _item(db, test_user, expected_sell_price=Decimal("19.99"))
    r = client.post(URL, headers=auth_headers, json={
        "item_ids": [str(a.id), str(b.id)],
        "list_price": {"mode": "percent", "value": -10},
        "buy_price": 5,
    })
    assert r.status_code == 200, r.text
    assert r.json() == {"updated": 2, "skipped": []}
    db.refresh(a)
    db.refresh(b)
    assert a.expected_sell_price == Decimal("90.00")
    assert b.expected_sell_price == Decimal("17.99")
    assert a.buy_price == Decimal("5.00")


def test_set_and_amount_modes_never_go_negative(client, db, test_user, auth_headers):
    a = _item(db, test_user, expected_sell_price=Decimal("3.00"))
    r = client.post(URL, headers=auth_headers, json={
        "item_ids": [str(a.id)], "list_price": {"mode": "amount", "value": -5}})
    assert r.json()["updated"] == 1
    db.refresh(a)
    assert a.expected_sell_price == Decimal("0.00")
    r = client.post(URL, headers=auth_headers, json={
        "item_ids": [str(a.id)], "list_price": {"mode": "set", "value": 42}})
    db.refresh(a)
    assert a.expected_sell_price == Decimal("42.00")


def test_relative_change_skips_items_without_price(client, db, test_user, auth_headers):
    a = _item(db, test_user)
    r = client.post(URL, headers=auth_headers, json={
        "item_ids": [str(a.id)], "list_price": {"mode": "percent", "value": 10}})
    assert r.json()["updated"] == 0
    assert r.json()["skipped"][0]["reason"] == "No list price to adjust"


def test_status_respects_state_machine(client, db, test_user, auth_headers):
    ok = _item(db, test_user, status="in_stock")
    sold = _item(db, test_user, status="sold")
    r = client.post(URL, headers=auth_headers, json={
        "item_ids": [str(ok.id), str(sold.id)], "status": "listed"})
    body = r.json()
    assert body["updated"] == 1
    assert body["skipped"][0]["id"] == str(sold.id)
    db.refresh(ok)
    db.refresh(sold)
    assert ok.status == "listed"
    assert sold.status == "sold"


def test_sold_is_not_a_bulk_status(client, db, test_user, auth_headers):
    a = _item(db, test_user)
    r = client.post(URL, headers=auth_headers, json={"item_ids": [str(a.id)], "status": "sold"})
    assert r.status_code == 422


def test_category_and_platform(client, db, test_user, auth_headers):
    a = _item(db, test_user)
    client.post(URL, headers=auth_headers, json={
        "item_ids": [str(a.id)], "category": " Sneakers ", "platform": "eBay"})
    db.refresh(a)
    assert (a.category, a.platform) == ("Sneakers", "eBay")


def test_other_users_items_are_untouched(client, db, test_user, second_user, auth_headers):
    theirs = _item(db, second_user, expected_sell_price=Decimal("50.00"))
    r = client.post(URL, headers=auth_headers, json={
        "item_ids": [str(theirs.id), "not-a-uuid"], "list_price": {"mode": "set", "value": 1}})
    assert r.json()["updated"] == 0
    assert len(r.json()["skipped"]) == 2
    db.refresh(theirs)
    assert theirs.expected_sell_price == Decimal("50.00")


def test_rejects_empty_requests(client, test_user, auth_headers):
    assert client.post(URL, headers=auth_headers, json={"item_ids": []}).status_code == 400
    assert client.post(URL, headers=auth_headers, json={"item_ids": ["x"]}).status_code == 400


def test_requires_auth(client):
    assert client.post(URL, json={"item_ids": ["x"], "buy_price": 1}).status_code == 401
