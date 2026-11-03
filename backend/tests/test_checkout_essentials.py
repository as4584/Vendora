"""Checkout essentials: discounts, sales tax, split payments, sizes, scan, show summary."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.models.inventory import InventoryItem
from app.models.transaction import OrderPayment, Transaction
from app.services.checkout import allocate, compute_order_amounts

API = "/api/v1"
D = Decimal


def _item(db, user, name="Dunk Low", qty=2, price="150.00", buy="80.00", **extra):
    item = InventoryItem(
        user_id=user.id, name=name, quantity=qty, expected_sell_price=D(price),
        buy_price=D(buy) if buy is not None else None, **extra,
    )
    db.add(item)
    db.commit()
    return item


def _order(client, headers, lines, **extra):
    body = {"lines": lines, **extra}
    if "payments" not in extra:
        body.setdefault("method", "cash")
    return client.post(f"{API}/transactions/order", json=body, headers=headers)


def _line(item, price, qty=1, **extra):
    return {"item_id": str(item.id), "unit_price": price, "quantity": qty, **extra}


class TestMath:
    def test_allocate_sums_exactly_and_skips_free_lines(self):
        parts = allocate(D("10.00"), [D("1.00"), D("1.00"), D("1.00"), D("0.00")])
        assert sum(parts) == D("10.00")
        assert parts[-1] == D("0.00")

    @pytest.mark.parametrize("pct", ["3", "7.5", "33.33", "100"])
    def test_percent_discount_and_tax_sum_exactly(self, pct):
        lines = [(D("19.99"), 3), (D("0.01"), 1), (D("333.33"), 1), (D("7.77"), 2)]
        a = compute_order_amounts(lines, discount_percent=D(pct), tax_rate=D("6.625"))
        assert sum(a.line_discounts) == a.discount
        assert sum(a.line_grosses) == a.gross == a.subtotal - a.discount
        assert sum(a.line_taxes) == a.tax
        assert a.total == a.gross + a.tax
        assert all(g >= 0 for g in a.line_grosses)

    def test_discount_above_subtotal_raises(self):
        with pytest.raises(ValueError):
            compute_order_amounts([(D("5.00"), 1)], discount_amount=D("5.01"))


class TestDiscountAndTax:
    def test_fixed_discount_is_split_by_line_value(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, "Cheap", qty=1)
        b = _item(db, test_user, "Pricey", qty=1)
        resp = _order(client, auth_headers, [_line(a, "25.00"), _line(b, "75.00")], discount_amount="10.00")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert D(body["subtotal_amount"]) == D("100.00")
        assert D(body["discount_amount"]) == D("10.00")
        assert D(body["gross_amount"]) == D("90.00")
        assert D(body["total_amount"]) == D("90.00")
        lines = body["transactions"]
        assert [D(t["discount_amount"]) for t in lines] == [D("2.50"), D("7.50")]
        assert [D(t["gross_amount"]) for t in lines] == [D("22.50"), D("67.50")]

    def test_percent_discount_with_awkward_cents(self, client, auth_headers, db, test_user):
        items = [_item(db, test_user, f"I{i}", qty=1) for i in range(3)]
        resp = _order(client, auth_headers, [_line(i, "33.33") for i in items], discount_percent="15")
        body = resp.json()
        assert D(body["discount_amount"]) == D("15.00")  # 15% of 99.99, rounded
        assert sum(D(t["discount_amount"]) for t in body["transactions"]) == D("15.00")
        assert sum(D(t["gross_amount"]) for t in body["transactions"]) == D("84.99")

    @pytest.mark.parametrize("extra", [
        {"discount_amount": "100.01"},
        {"discount_amount": "5.00", "discount_percent": "5"},
        {"discount_percent": "101"},
    ])
    def test_bad_discounts_are_422(self, client, auth_headers, db, test_user, extra):
        a = _item(db, test_user, qty=1)
        assert _order(client, auth_headers, [_line(a, "100.00")], **extra).status_code == 422

    def test_tax_is_collected_but_never_profit(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, qty=1, buy="60.00")
        resp = _order(client, auth_headers, [_line(a, "100.00")], tax_rate="6.625", fee_amount="3.00")
        body = resp.json()
        assert D(body["tax_amount"]) == D("6.63")
        assert D(body["gross_amount"]) == D("100.00")
        assert D(body["total_amount"]) == D("106.63")
        txn = body["transactions"][0]
        assert D(txn["net_amount"]) == D("97.00")  # gross - fee, tax not included
        summary = client.get(f"{API}/dashboard/show-summary", headers=auth_headers).json()
        assert D(summary["tax_collected"]) == D("6.63")
        assert D(summary["profit"]) == D("37.00")  # 100 - 3 fee - 60 cost
        assert D(summary["collected"]) == D("106.63")

    def test_fee_cannot_exceed_discounted_total(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, qty=1)
        resp = _order(client, auth_headers, [_line(a, "100.00")], discount_amount="95.00", fee_amount="6.00")
        assert resp.status_code == 422

    def test_seller_default_tax_rate_round_trips(self, client, auth_headers):
        resp = client.patch(f"{API}/auth/profile", json={"sales_tax_rate": "6.625"}, headers=auth_headers)
        assert resp.status_code == 200
        assert D(client.get(f"{API}/auth/me", headers=auth_headers).json()["sales_tax_rate"]) == D("6.625")
        assert client.patch(f"{API}/auth/profile", json={"sales_tax_rate": "31"}, headers=auth_headers).status_code == 422


class TestSplitPayments:
    def test_cash_plus_card_must_match_total(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, qty=1)
        b = _item(db, test_user, "Jordan 4", qty=1)
        resp = _order(client, auth_headers, [_line(a, "185.00"), _line(b, "100.00")], payments=[
            {"method": "cash", "amount": "200.00"},
            {"method": "card", "amount": "85.00"},
        ], fee_amount="2.50")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert [(p["method"], D(p["amount"])) for p in body["payments"]] == [
            ("cash", D("200.00")), ("card", D("85.00")),
        ]
        assert {t["method"] for t in body["transactions"]} == {"split"}
        summary = client.get(f"{API}/dashboard/show-summary", headers=auth_headers).json()
        by = {row["method"]: D(row["net"]) for row in summary["payments"]}
        assert by == {"cash": D("200.00"), "card": D("85.00")}

    @pytest.mark.parametrize("parts", [
        [{"method": "cash", "amount": "200.00"}, {"method": "card", "amount": "84.99"}],
        [{"method": "cash", "amount": "285.01"}],
    ])
    def test_mismatched_split_is_422_and_writes_nothing(self, client, auth_headers, db, test_user, parts):
        a = _item(db, test_user, qty=1)
        resp = _order(client, auth_headers, [_line(a, "285.00")], payments=parts)
        assert resp.status_code == 422
        assert db.query(Transaction).filter(Transaction.user_id == test_user.id).count() == 0

    def test_split_includes_tax(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, qty=1)
        resp = _order(client, auth_headers, [_line(a, "100.00")], tax_rate="10", payments=[
            {"method": "cash", "amount": "50.00"}, {"method": "venmo", "amount": "60.00"},
        ])
        assert resp.status_code == 201, resp.text

    def test_method_or_payments_required(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, qty=1)
        both = client.post(f"{API}/transactions/order", json={
            "lines": [_line(a, "10.00")], "method": "cash", "payments": [{"method": "cash", "amount": "10.00"}],
        }, headers=auth_headers)
        neither = client.post(f"{API}/transactions/order", json={"lines": [_line(a, "10.00")]}, headers=auth_headers)
        assert both.status_code == 422
        assert neither.status_code == 422

    def test_split_replay_is_idempotent(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, qty=3)
        kwargs = dict(payments=[{"method": "cash", "amount": "60.00"}, {"method": "card", "amount": "40.00"}],
                      client_request_id="ob_split_replay_1")
        first = _order(client, auth_headers, [_line(a, "100.00")], **kwargs).json()
        again = _order(client, auth_headers, [_line(a, "100.00")], **kwargs)
        assert again.status_code == 201
        assert again.json()["order_id"] == first["order_id"]
        assert len(again.json()["payments"]) == 2
        db.expire_all()
        assert db.query(OrderPayment).filter(OrderPayment.user_id == test_user.id).count() == 2
        assert db.get(InventoryItem, a.id).quantity == 2

    def test_failure_rolls_back_lines_and_payments(self, client, auth_headers, db, test_user):
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
            resp = _order(client, auth_headers, [_line(a, "50.00"), _line(b, "50.00")], payments=[
                {"method": "cash", "amount": "70.00"}, {"method": "card", "amount": "30.00"},
            ])
        assert resp.status_code == 409
        db.expire_all()
        assert db.query(Transaction).filter(Transaction.user_id == test_user.id).count() == 0
        assert db.query(OrderPayment).filter(OrderPayment.user_id == test_user.id).count() == 0
        assert db.get(InventoryItem, a.id).quantity == 3

    def test_order_can_be_fetched_for_a_receipt(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, qty=1)
        order = _order(client, auth_headers, [_line(a, "40.00")], method="card").json()
        got = client.get(f"{API}/transactions/order/{order['order_id']}", headers=auth_headers)
        assert got.status_code == 200
        assert got.json()["payments"] == [{"method": "card", "amount": "40.00"}]
        missing = client.get(f"{API}/transactions/order/00000000-0000-0000-0000-000000000009", headers=auth_headers)
        assert missing.status_code == 404


class TestSizes:
    def _sized(self, db, user):
        return _item(db, user, "Jordan 1", qty=3, custom_attributes={"variants": [
            {"size": "9", "quantity": 1}, {"size": "10.5", "quantity": 2},
        ]})

    def test_selling_a_size_decrements_that_variant_and_total(self, client, auth_headers, db, test_user):
        item = self._sized(db, test_user)
        resp = _order(client, auth_headers, [_line(item, "200.00", size="10.5")])
        assert resp.status_code == 201, resp.text
        assert resp.json()["transactions"][0]["variant_size"] == "10.5"
        db.expire_all()
        fresh = db.get(InventoryItem, item.id)
        assert fresh.quantity == 2
        assert {v["size"]: v["quantity"] for v in fresh.custom_attributes["variants"]} == {"9": 1, "10.5": 1}

    def test_size_out_of_stock_is_409_and_nothing_written(self, client, auth_headers, db, test_user):
        item = self._sized(db, test_user)
        resp = _order(client, auth_headers, [_line(item, "200.00", qty=2, size="9")])
        assert resp.status_code == 409
        assert resp.json()["detail"]["error"] == "insufficient_size_stock"
        unknown = _order(client, auth_headers, [_line(item, "200.00", size="13")])
        assert unknown.json()["detail"]["error"] == "size_not_available"
        db.expire_all()
        assert db.get(InventoryItem, item.id).quantity == 3

    def test_refund_puts_the_unit_back_on_its_size(self, client, auth_headers, db, test_user):
        item = self._sized(db, test_user)
        txn = _order(client, auth_headers, [_line(item, "200.00", size="9")]).json()["transactions"][0]
        assert client.post(f"{API}/transactions/{txn['id']}/refund", json={}, headers=auth_headers).status_code == 201
        db.expire_all()
        fresh = db.get(InventoryItem, item.id)
        assert fresh.quantity == 3
        assert {v["size"]: v["quantity"] for v in fresh.custom_attributes["variants"]} == {"9": 1, "10.5": 2}


class TestScanLookup:
    def test_upc_filter_matches_exactly_and_tolerates_leading_zero(self, client, auth_headers, db, test_user):
        _item(db, test_user, "Scanned", upc="012345678905")
        _item(db, test_user, "Other", upc="999")
        hit = client.get(f"{API}/inventory", params={"upc": "12345678905"}, headers=auth_headers).json()
        assert [i["name"] for i in hit["items"]] == ["Scanned"]
        hit13 = client.get(f"{API}/inventory", params={"upc": "0012345678905"}, headers=auth_headers).json()
        assert [i["name"] for i in hit13["items"]] == ["Scanned"]
        miss = client.get(f"{API}/inventory", params={"upc": "123"}, headers=auth_headers).json()
        assert miss["items"] == []


class TestShowSummary:
    def test_full_close_out(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, "Dunk Low", qty=5, buy="50.00")
        b = _item(db, test_user, "Tee", qty=5, buy="5.00")
        c = _item(db, test_user, "No cost", qty=1, buy=None)
        _order(client, auth_headers, [_line(a, "100.00", qty=2), _line(b, "20.00")],
               discount_amount="20.00", tax_rate="5", payments=[
                   {"method": "cash", "amount": "150.00"}, {"method": "card", "amount": "60.00"},
               ], fee_amount="1.50")
        refunded = _order(client, auth_headers, [_line(b, "25.00")], method="cash").json()
        _order(client, auth_headers, [_line(c, "10.00")], method="venmo")
        rr = client.post(f"{API}/transactions/{refunded["transactions"][0]["id"]}/refund", json={}, headers=auth_headers)
        assert rr.status_code == 201, rr.text

        s = client.get(f"{API}/dashboard/show-summary", headers=auth_headers).json()
        assert s["orders"] == 3
        assert s["units_sold"] == 5
        assert s["units_refunded"] == 1
        assert D(s["subtotal"]) == D("255.00")
        assert D(s["discounts"]) == D("20.00")
        assert D(s["net_sales"]) == D("235.00")
        assert D(s["tax_collected"]) == D("10.00")
        assert D(s["fees"]) == D("1.50")
        assert D(s["refunds"]) == D("25.00")
        assert s["refund_count"] == 1
        assert D(s["cost_of_goods"]) == D("105.00")  # 2x50 + 5 + 5 - 5 refunded
        assert s["sales_missing_cost"] == 1
        assert D(s["profit"]) == D("235.00") - D("25.00") - D("1.50") - D("105.00")
        assert D(s["collected"]) == D("220.00")
        by = {row["method"]: D(row["net"]) for row in s["payments"]}
        assert by == {"cash": D("150.00"), "card": D("60.00"), "venmo": D("10.00")}
        assert s["top_items"][0]["name"] == "Dunk Low"

    def test_window_and_show_start(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, qty=2)
        _order(client, auth_headers, [_line(a, "10.00")])
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        empty = client.get(f"{API}/dashboard/show-summary", params={"since": future,
                           "until": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()},
                           headers=auth_headers).json()
        assert empty["orders"] == 0 and empty["payments"] == [] and D(empty["profit"]) == 0

        started = client.put(f"{API}/dashboard/show-start", json={}, headers=auth_headers)
        assert started.status_code == 200
        assert started.json()["show_started_at"]
        after = client.get(f"{API}/dashboard/show-summary", headers=auth_headers).json()
        assert after["orders"] == 0  # sale happened before the show started
        assert client.put(f"{API}/dashboard/show-start", json={"started_at": future}, headers=auth_headers).status_code == 422
        assert client.delete(f"{API}/dashboard/show-start", headers=auth_headers).status_code == 204
        assert client.get(f"{API}/dashboard/show-summary", headers=auth_headers).json()["orders"] == 1

    def test_inverted_window_is_422(self, client, auth_headers):
        now = datetime.now(timezone.utc)
        resp = client.get(f"{API}/dashboard/show-summary", params={
            "since": now.isoformat(), "until": (now - timedelta(hours=1)).isoformat()}, headers=auth_headers)
        assert resp.status_code == 422

    def test_requires_auth(self, client):
        assert client.get(f"{API}/dashboard/show-summary").status_code in (401, 403)
