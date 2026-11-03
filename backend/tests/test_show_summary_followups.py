"""Show summary follow-ups: net-of-refund top items, split refunds by part, local 'today'."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.models.inventory import InventoryItem
from app.routers.dashboard import local_day_start

API = "/api/v1"
D = Decimal


def _item(db, user, name, qty=5, buy="10.00"):
    item = InventoryItem(user_id=user.id, name=name, quantity=qty, expected_sell_price=D("50.00"),
                         buy_price=D(buy))
    db.add(item)
    db.commit()
    return item


def _sell(client, headers, lines, **extra):
    body = {"lines": lines, **extra}
    if "payments" not in extra:
        body.setdefault("method", "cash")
    resp = client.post(f"{API}/transactions/order", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _line(item, price, qty=1):
    return {"item_id": str(item.id), "unit_price": price, "quantity": qty}


def _refund(client, headers, txn_id):
    resp = client.post(f"{API}/transactions/{txn_id}/refund", json={}, headers=headers)
    assert resp.status_code == 201, resp.text


def _summary(client, headers, **params):
    resp = client.get(f"{API}/dashboard/show-summary", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestTopItemsNetOfRefunds:
    def test_refunded_units_come_off_the_item(self, client, auth_headers, db, test_user):
        big = _item(db, test_user, "Jordan 1")
        small = _item(db, test_user, "Tee")
        order = _sell(client, auth_headers, [_line(big, "300.00")])
        _sell(client, auth_headers, [_line(small, "40.00", qty=2)])
        _refund(client, auth_headers, order["transactions"][0]["id"])

        s = _summary(client, auth_headers)
        names = [row["name"] for row in s["top_items"]]
        # The Jordan was fully refunded: it no longer tops the list (or appears at all).
        assert names == ["Tee"]
        assert s["top_items"][0]["units"] == 2
        assert D(s["top_items"][0]["revenue"]) == D("80.00")

    def test_partial_refund_nets_units_and_revenue(self, client, auth_headers, db, test_user):
        item = _item(db, test_user, "Dunk")
        first = _sell(client, auth_headers, [_line(item, "100.00")])
        _sell(client, auth_headers, [_line(item, "100.00")])
        _refund(client, auth_headers, first["transactions"][0]["id"])
        top = _summary(client, auth_headers)["top_items"]
        assert top[0]["units"] == 1
        assert D(top[0]["revenue"]) == D("100.00")


class TestSplitRefundAttribution:
    def test_refund_goes_back_to_split_parts_proportionally(self, client, auth_headers, db, test_user):
        a = _item(db, test_user, "Yeezy")
        b = _item(db, test_user, "Cap")
        order = _sell(client, auth_headers, [_line(a, "200.00"), _line(b, "100.00")], payments=[
            {"method": "cash", "amount": "200.00"}, {"method": "card", "amount": "100.00"},
        ])
        cap_line = next(t for t in order["transactions"] if t["item_id"] == str(b.id))
        _refund(client, auth_headers, cap_line["id"])

        s = _summary(client, auth_headers)
        rows = {row["method"]: row for row in s["payments"]}
        assert "split" not in rows
        # $100 refund on a 2/3 cash, 1/3 card order.
        assert D(rows["cash"]["refunded"]) == D("66.67")
        assert D(rows["card"]["refunded"]) == D("33.33")
        assert D(rows["cash"]["net"]) + D(rows["card"]["net"]) == D(s["collected"])

    def test_awkward_cents_sum_exactly(self, client, auth_headers, db, test_user):
        items = [_item(db, test_user, f"Pin {i}") for i in range(3)]
        order = _sell(client, auth_headers, [_line(i, "10.00") for i in items], payments=[
            {"method": "cash", "amount": "10.00"}, {"method": "card", "amount": "10.00"},
            {"method": "venmo", "amount": "10.00"},
        ])
        _refund(client, auth_headers, order["transactions"][0]["id"])
        rows = {row["method"]: D(row["refunded"]) for row in _summary(client, auth_headers)["payments"]}
        assert sum(rows.values()) == D("10.00")
        assert set(rows) == {"cash", "card", "venmo"}


class TestLocalToday:
    def test_local_day_start_math(self):
        now = datetime(2026, 11, 3, 2, 30, tzinfo=timezone.utc)  # 9:30 PM Nov 2 in New York (EST)
        assert local_day_start(now, 300) == datetime(2026, 11, 2, 5, 0, tzinfo=timezone.utc)
        assert local_day_start(now, None) == datetime(2026, 11, 3, 0, 0, tzinfo=timezone.utc)
        assert local_day_start(now, -60) == datetime(2026, 11, 2, 23, 0, tzinfo=timezone.utc)

    def test_window_starts_at_local_midnight(self, client, auth_headers):
        offset = 300
        s = _summary(client, auth_headers, tz_offset_minutes=offset)
        since = datetime.fromisoformat(s["since"].replace("Z", "+00:00"))
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
        local = since - timedelta(minutes=offset)
        assert (local.hour, local.minute, local.second) == (0, 0, 0)
        assert datetime.now(timezone.utc) - since < timedelta(days=1)

    def test_offset_out_of_range_is_422(self, client, auth_headers):
        resp = client.get(f"{API}/dashboard/show-summary", params={"tz_offset_minutes": 5000},
                          headers=auth_headers)
        assert resp.status_code == 422
