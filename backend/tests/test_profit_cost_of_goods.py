"""Regression: profit must subtract the cost of exactly the units sold.

Found by the visual layout pass: a busy seller's dashboard showed $314 profit
for sales whose true profit was $148, because cost was only counted for items
whose status had flipped to "sold" (and only once per item).
"""
from decimal import Decimal

from app.models.inventory import InventoryItem
from app.models.transaction import Transaction

API = "/api/v1"


def _item(db, user, name, qty, buy, sell="100.00"):
    item = InventoryItem(user_id=user.id, name=name, quantity=qty,
                         buy_price=Decimal(buy) if buy is not None else None,
                         expected_sell_price=Decimal(sell))
    db.add(item)
    db.commit()
    return item


def _sell(client, headers, lines, method="cash"):
    resp = client.post(f"{API}/transactions/order", json={"method": method, "lines": lines}, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _dash(client, headers):
    return client.get(f"{API}/dashboard", headers=headers).json()


def test_partial_and_multi_unit_sales_subtract_their_cost(client, auth_headers, db, test_user):
    dunk = _item(db, test_user, "Dunk", qty=3, buy="110.00")
    packs = _item(db, test_user, "Packs", qty=6, buy="28.00")
    jordan = _item(db, test_user, "Jordan 4", qty=1, buy="215.00")
    _sell(client, auth_headers, [
        {"item_id": str(dunk.id), "quantity": 1, "unit_price": "160.00"},
        {"item_id": str(packs.id), "quantity": 2, "unit_price": "42.00"},
    ])
    _sell(client, auth_headers, [{"item_id": str(jordan.id), "quantity": 1, "unit_price": "285.00"}], method="card")
    # revenue 529, cost 110 + 56 + 215 = 381
    assert Decimal(_dash(client, auth_headers)["net_profit_today"]) == Decimal("148.00")


def test_cost_is_frozen_at_sale_time(client, auth_headers, db, test_user):
    dunk = _item(db, test_user, "Dunk", qty=2, buy="100.00")
    _sell(client, auth_headers, [{"item_id": str(dunk.id), "unit_price": "150.00"}])
    dunk.buy_price = Decimal("999.00")  # later edit must not rewrite history
    db.commit()
    assert Decimal(_dash(client, auth_headers)["net_profit_today"]) == Decimal("50.00")


def test_refund_reverses_revenue_and_cost(client, auth_headers, db, test_user):
    dunk = _item(db, test_user, "Dunk", qty=1, buy="100.00")
    order = _sell(client, auth_headers, [{"item_id": str(dunk.id), "unit_price": "150.00"}])
    txn_id = order["transactions"][0]["id"]
    assert client.post(f"{API}/transactions/{txn_id}/refund", json={"reason": "returned"},
                       headers=auth_headers).status_code == 201
    assert Decimal(_dash(client, auth_headers)["net_profit_today"]) == Decimal("0.00")
    refund = db.query(Transaction).filter(Transaction.is_refund.is_(True)).one()
    assert refund.cost_amount == Decimal("-100.00")


def test_unknown_cost_counts_as_zero_not_a_crash(client, auth_headers, db, test_user):
    mystery = _item(db, test_user, "No cost", qty=1, buy=None)
    _sell(client, auth_headers, [{"item_id": str(mystery.id), "unit_price": "40.00"}])
    assert Decimal(_dash(client, auth_headers)["net_profit_today"]) == Decimal("40.00")


def test_inventory_value_counts_every_unit(client, auth_headers, db, test_user):
    _item(db, test_user, "Dunk", qty=2, buy="110.00", sell="165.00")
    _item(db, test_user, "Packs", qty=4, buy="28.00", sell="45.00")
    dash = _dash(client, auth_headers)
    assert Decimal(dash["total_inventory_value"]) == Decimal("332.00")
    assert Decimal(dash["total_expected_value"]) == Decimal("510.00")


def test_card_is_a_payment_method(client, auth_headers, db, test_user):
    item = _item(db, test_user, "Hoodie", qty=1, buy="50.00")
    body = _sell(client, auth_headers, [{"item_id": str(item.id), "unit_price": "80.00"}], method="card")
    assert body["transactions"][0]["method"] == "card"
