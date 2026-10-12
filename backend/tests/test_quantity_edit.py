"""Editing an item's quantity must not undo stock changes made meanwhile."""
import uuid

from app.models.inventory import InventoryStockLedger


def _item(client, auth_headers, qty=5):
    return client.post("/api/v1/inventory", json={
        "name": "Edit Race Item", "buy_price": "10.00", "quantity": qty,
    }, headers=auth_headers).json()


def _sell(client, auth_headers, item_id, qty=1):
    r = client.post("/api/v1/transactions", json={
        "item_id": item_id, "method": "cash", "gross_amount": "20.00", "quantity": qty,
    }, headers=auth_headers)
    assert r.status_code == 201, r.text


def test_edit_applies_only_the_users_change(client, auth_headers):
    item = _item(client, auth_headers, qty=5)
    # The user opens the edit screen at 5; meanwhile 2 units sell.
    _sell(client, auth_headers, item["id"], qty=2)
    # The user bumps 5 -> 7 (+2). Result must be 3 + 2 = 5, not 7.
    r = client.put(f"/api/v1/inventory/{item['id']}", json={
        "name": "Edit Race Item", "quantity": 7, "expected_quantity": 5,
    }, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["quantity"] == 5


def test_unchanged_quantity_does_not_overwrite_sales(client, auth_headers):
    item = _item(client, auth_headers, qty=5)
    _sell(client, auth_headers, item["id"], qty=1)
    # A rename that re-sends the stale quantity must leave stock at 4.
    r = client.put(f"/api/v1/inventory/{item['id']}", json={
        "name": "Renamed", "quantity": 5, "expected_quantity": 5,
    }, headers=auth_headers)
    assert r.json()["quantity"] == 4
    assert r.json()["name"] == "Renamed"


def test_edit_to_zero_marks_sold_and_back_restocks(client, auth_headers, db):
    item = _item(client, auth_headers, qty=2)
    r = client.put(f"/api/v1/inventory/{item['id']}", json={"quantity": 0}, headers=auth_headers)
    assert r.json()["quantity"] == 0 and r.json()["status"] == "sold"
    r = client.put(f"/api/v1/inventory/{item['id']}", json={"quantity": 3}, headers=auth_headers)
    assert r.json()["quantity"] == 3 and r.json()["status"] == "in_stock"

    deltas = [e.delta_quantity for e in db.query(InventoryStockLedger)
              .filter(InventoryStockLedger.inventory_item_id == uuid.UUID(item["id"]),
                      InventoryStockLedger.event_type == "manual_adjust")
              .order_by(InventoryStockLedger.created_at).all()]
    assert sorted(deltas) == [-2, 3]


def test_quantity_never_goes_negative(client, auth_headers):
    item = _item(client, auth_headers, qty=1)
    _sell(client, auth_headers, item["id"], qty=1)
    r = client.put(f"/api/v1/inventory/{item['id']}", json={
        "quantity": 0, "expected_quantity": 5,
    }, headers=auth_headers)
    assert r.json()["quantity"] == 0
