"""eBay sale push alerts: device registration, message, recency guard, Expo delivery."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.models.push_token import PushToken
from app.services import push

TOKEN = "ExponentPushToken[abc123]"


def _iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) - delta).isoformat().replace("+00:00", "Z")


def _order(oid="1-1", ago=timedelta(minutes=5), title="Jordan 1 Chicago", total="250.00", lines=1):
    return {
        "orderId": oid,
        "creationDate": _iso(ago),
        "lineItems": [{"title": title}] + [{"title": "x"}] * (lines - 1),
        "pricingSummary": {"total": {"value": total}},
    }


class FakeResp:
    def __init__(self, tickets):
        self._t = tickets

    def json(self):
        return {"data": self._t}


@pytest.fixture()
def expo(monkeypatch):
    sent = []
    tickets = {"value": None}

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json):
            sent.append(json)
            return FakeResp(tickets["value"] or [{"status": "ok"} for _ in json])

    monkeypatch.setattr(push.httpx, "AsyncClient", FakeClient)
    return sent, tickets


# ── device registration ───────────────────────────────────────────────────────


def test_register_token_and_reassign(client, db, auth_headers, test_user):
    r = client.post("/api/v1/devices/push-token", json={"token": TOKEN, "platform": "ios"}, headers=auth_headers)
    assert r.status_code == 204
    r = client.post("/api/v1/devices/push-token", json={"token": TOKEN, "platform": "ios"}, headers=auth_headers)
    assert r.status_code == 204
    rows = db.query(PushToken).all()
    assert len(rows) == 1 and rows[0].user_id == test_user.id


def test_register_rejects_non_expo_token(client, auth_headers):
    r = client.post("/api/v1/devices/push-token", json={"token": "not-a-real-token"}, headers=auth_headers)
    assert r.status_code == 422


def test_register_requires_auth(client):
    assert client.post("/api/v1/devices/push-token", json={"token": TOKEN}).status_code == 401


def test_remove_token(client, db, auth_headers):
    client.post("/api/v1/devices/push-token", json={"token": TOKEN}, headers=auth_headers)
    r = client.post("/api/v1/devices/push-token/remove", json={"token": TOKEN}, headers=auth_headers)
    assert r.status_code == 204
    assert db.query(PushToken).count() == 0


# ── message + recency ─────────────────────────────────────────────────────────


def test_sale_message():
    assert push.sale_message(_order()) == ("Sold on eBay", "Jordan 1 Chicago sold for $250.00.")
    assert push.sale_message(_order(lines=3))[1] == "Jordan 1 Chicago + 2 more sold for $250.00."
    assert push.sale_message({"lineItems": []})[1] == "An item sold."
    assert push.sale_message(_order(total="abc"))[1] == "Jordan 1 Chicago sold."


def test_recency_guard():
    assert push.is_recent_order(_order(ago=timedelta(hours=1)))
    assert not push.is_recent_order(_order(ago=timedelta(days=3)))
    assert not push.is_recent_order({"orderId": "x"})
    assert not push.is_recent_order({"creationDate": "garbage"})


# ── delivery ──────────────────────────────────────────────────────────────────


def test_notify_sends_for_recent_only(db, test_user, expo):
    sent, _ = expo
    db.add(PushToken(user_id=test_user.id, token=TOKEN))
    db.commit()
    n = asyncio.run(push.notify_ebay_sales(db, test_user.id, [_order("a"), _order("b", ago=timedelta(days=30))]))
    assert n == 1
    assert len(sent) == 1
    msg = sent[0][0]
    assert msg["to"] == TOKEN and msg["data"] == {"type": "ebay_sale", "orderId": "a"}


def test_notify_batches_many_sales(db, test_user, expo):
    sent, _ = expo
    db.add(PushToken(user_id=test_user.id, token=TOKEN))
    db.commit()
    orders = [_order(str(i)) for i in range(5)]
    assert asyncio.run(push.notify_ebay_sales(db, test_user.id, orders)) == 1
    assert len(sent) == 1 and sent[0][0]["body"] == "5 new eBay sales."


def test_no_tokens_no_send(db, test_user, expo):
    sent, _ = expo
    assert asyncio.run(push.notify_ebay_sales(db, test_user.id, [_order()])) == 0
    assert sent == []


def test_disabled_flag(db, test_user, expo, monkeypatch):
    sent, _ = expo
    monkeypatch.setattr(push.settings, "PUSH_ENABLED", False)
    db.add(PushToken(user_id=test_user.id, token=TOKEN))
    db.commit()
    assert asyncio.run(push.notify_ebay_sales(db, test_user.id, [_order()])) == 0
    assert sent == []


def test_dead_token_pruned(db, test_user, expo):
    _, tickets = expo
    tickets["value"] = [{"status": "error", "details": {"error": "DeviceNotRegistered"}}]
    db.add(PushToken(user_id=test_user.id, token=TOKEN))
    db.commit()
    assert asyncio.run(push.notify_ebay_sales(db, test_user.id, [_order()])) == 0
    assert db.query(PushToken).count() == 0


def test_expo_failure_never_raises(db, test_user, monkeypatch):
    class Boom:
        def __init__(self, *a, **kw):
            raise RuntimeError("network down")

    monkeypatch.setattr(push.httpx, "AsyncClient", Boom)
    db.add(PushToken(user_id=test_user.id, token=TOKEN))
    db.commit()
    assert asyncio.run(push.notify_ebay_sales(db, test_user.id, [_order()])) == 0


def test_notify_swallows_unexpected_errors(db, test_user, monkeypatch):
    def bad(*a, **kw):
        raise ValueError("bad order")

    monkeypatch.setattr(push, "is_recent_order", bad)
    assert asyncio.run(push.notify_ebay_sales(db, test_user.id, [_order()])) == 0
