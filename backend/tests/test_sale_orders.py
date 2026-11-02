"""POST /transactions/order — multi-item checkout recorded all-or-nothing."""
from decimal import Decimal
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.models.inventory import InventoryItem
from app.models.transaction import Transaction
from app.routers.transactions import _allocate_fee

API = "/api/v1"


def _item(db, user, name="Dunk Low", qty=2, price="150.00"):
    item = InventoryItem(user_id=user.id, name=name, quantity=qty, expected_sell_price=Decimal(price))
    db.add(item)
    db.commit()
    return item


def _order(client, headers, lines, **extra):
    return client.post(f"{API}/transactions/order", json={"method": "cash", "lines": lines, **extra}, headers=headers)


def _count_txns(db, user):
    return db.query(Transaction).filter(Transaction.user_id == user.id).count()


class TestSaleOrder:
    def test_records_all_lines_with_haggled_prices(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, "Dunk Low", qty=2)
        b = _item(db, test_user, "Jordan 4", qty=1, price="300.00")
        resp = _order(client, auth_headers, [
            {"item_id": str(a.id), "quantity": 2, "unit_price": "120.00"},  # haggled from 150
            {"item_id": str(b.id), "quantity": 1, "unit_price": "280.00"},
        ], fee_amount="10.00", notes="Con day 1")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert Decimal(body["gross_amount"]) == Decimal("520.00")
        assert Decimal(body["fee_amount"]) == Decimal("10.00")
        assert Decimal(body["net_amount"]) == Decimal("510.00")
        assert len({t["order_id"] for t in body["transactions"]}) == 1
        db.expire_all()
        assert db.get(InventoryItem, a.id).quantity == 0
        assert db.get(InventoryItem, a.id).status == "sold"
        assert db.get(InventoryItem, b.id).quantity == 0
        assert db.get(InventoryItem, a.id).actual_sell_price == Decimal("120.00")

    def test_fee_is_split_by_line_value_not_dumped_on_first_line(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, "Cheap", qty=1, price="10.00")
        b = _item(db, test_user, "Pricey", qty=1, price="90.00")
        body = _order(client, auth_headers, [
            {"item_id": str(a.id), "unit_price": "10.00"},
            {"item_id": str(b.id), "unit_price": "90.00"},
        ], fee_amount="5.00").json()
        fees = [Decimal(t["fee_amount"]) for t in body["transactions"]]
        assert fees == [Decimal("0.50"), Decimal("4.50")]

    def test_one_short_line_rejects_the_whole_order(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, "In stock", qty=5)
        b = _item(db, test_user, "Last pair", qty=1)
        resp = _order(client, auth_headers, [
            {"item_id": str(a.id), "quantity": 1, "unit_price": "100.00"},
            {"item_id": str(b.id), "quantity": 2, "unit_price": "100.00"},
        ])
        assert resp.status_code == 409
        assert resp.json()["detail"]["item_id"] == str(b.id)
        db.expire_all()
        assert _count_txns(db, test_user) == 0
        assert db.get(InventoryItem, a.id).quantity == 5

    def test_repeated_item_lines_are_counted_together(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, qty=2)
        resp = _order(client, auth_headers, [
            {"item_id": str(a.id), "quantity": 2, "unit_price": "100.00"},
            {"item_id": str(a.id), "quantity": 1, "unit_price": "100.00"},
        ])
        assert resp.status_code == 409
        assert _count_txns(db, test_user) == 0

    def test_failure_midway_rolls_everything_back(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, "First", qty=3)
        b = _item(db, test_user, "Second", qty=3)
        from app.services import inventory as inv

        real = inv.deduct_stock
        calls = {"n": 0}

        def flaky(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 2:
                raise HTTPException(status_code=409, detail="stock changed")
            return real(*args, **kwargs)

        with patch("app.routers.transactions.deduct_stock", side_effect=flaky):
            resp = _order(client, auth_headers, [
                {"item_id": str(a.id), "unit_price": "50.00"},
                {"item_id": str(b.id), "unit_price": "50.00"},
            ])
        assert resp.status_code == 409
        db.expire_all()
        assert _count_txns(db, test_user) == 0
        assert db.get(InventoryItem, a.id).quantity == 3

    def test_replay_returns_the_same_order_once(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, qty=3)
        lines = [{"item_id": str(a.id), "unit_price": "100.00"}]
        first = _order(client, auth_headers, lines, client_request_id="ob_replay_1234").json()
        again = _order(client, auth_headers, lines, client_request_id="ob_replay_1234")
        assert again.status_code == 201
        assert again.json()["order_id"] == first["order_id"]
        db.expire_all()
        assert _count_txns(db, test_user) == 1
        assert db.get(InventoryItem, a.id).quantity == 2

    def test_other_users_items_are_not_found(self, client, auth_headers, db, test_user):
        from app.models.user import User

        stranger = User(email="other-seller@example.com", password_hash="x")
        db.add(stranger)
        db.commit()
        theirs = _item(db, stranger, qty=1)
        resp = _order(client, auth_headers, [{"item_id": str(theirs.id), "unit_price": "1.00"}])
        assert resp.status_code == 404

    @pytest.mark.parametrize("payload,code", [
        ({"lines": []}, 422),
        ({"lines": [{"item_id": "00000000-0000-0000-0000-000000000001", "unit_price": "-1"}]}, 422),
        ({"lines": [{"item_id": "00000000-0000-0000-0000-000000000001", "unit_price": "5"}], "fee_amount": "6"}, 422),
    ])
    def test_validation(self, client, auth_headers, payload, code):
        resp = client.post(f"{API}/transactions/order", json={"method": "cash", **payload}, headers=auth_headers)
        assert resp.status_code == code


class TestAllocateFee:
    def test_sums_exactly(self):
        parts = _allocate_fee(Decimal("10.00"), [Decimal("33.33"), Decimal("33.33"), Decimal("33.34")])
        assert sum(parts) == Decimal("10.00")

    def test_zero_fee_or_zero_total(self):
        assert _allocate_fee(Decimal("0"), [Decimal("5")]) == [Decimal("0.00")]
        assert _allocate_fee(Decimal("1"), [Decimal("0"), Decimal("0")]) == [Decimal("0.00")] * 2
