"""Aging stock: GET /inventory/aging and the weekly Pro push reminder."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.app_event import AppEvent
from app.models.inventory import InventoryItem
from app.services import aging

URL = "/api/v1/inventory/aging"


def _item(db, user, days_old, **kw):
    item = InventoryItem(user_id=user.id, name=kw.pop("name", f"Item {days_old}d"), **kw)
    db.add(item)
    db.flush()
    item.created_at = datetime.now(timezone.utc) - timedelta(days=days_old)
    db.flush()
    return item


def test_lists_old_unsold_items_oldest_first(client, db, test_user, auth_headers):
    _item(db, test_user, 90, name="Old", expected_sell_price=Decimal("30"))
    _item(db, test_user, 61, name="Older than 60")
    _item(db, test_user, 10, name="Fresh")
    _item(db, test_user, 120, name="Sold", status="sold")
    _item(db, test_user, 120, name="Empty", quantity=0)
    body = client.get(URL, headers=auth_headers).json()
    assert body["count"] == 2
    assert [i["name"] for i in body["items"]] == ["Old", "Older than 60"]
    assert body["items"][0]["days_old"] == 90
    assert client.get(f"{URL}?days=30", headers=auth_headers).json()["count"] == 2
    assert client.get(f"{URL}?days=7", headers=auth_headers).json()["count"] == 3


def test_scoped_to_user_and_requires_auth(client, db, second_user, auth_headers):
    _item(db, second_user, 100)
    assert client.get(URL, headers=auth_headers).json()["count"] == 0
    assert client.get(URL).status_code == 401


def test_message_wording():
    assert aging.alert_message(1)[0] == "1 item has sat 60+ days"
    assert aging.alert_message(6)[0] == "6 items have sat 60+ days"


@pytest.mark.asyncio
async def test_weekly_push_to_pro_only(db, test_user, second_user, monkeypatch):
    sent = []

    async def fake_send(db_, user_id, title, body, data=None):
        sent.append((user_id, title, data))
        return 1

    monkeypatch.setattr("app.services.push.send_push", fake_send)
    test_user.subscription_tier = "pro"
    second_user.subscription_tier = "free"
    _item(db, test_user, 70)
    _item(db, test_user, 80)
    _item(db, second_user, 90)

    assert await aging.run_aging_alerts(db) == 1
    assert sent == [(test_user.id, "2 items have sat 60+ days", {"url": "/inventory/aging"})]
    assert db.query(AppEvent).filter_by(user_id=test_user.id, name=aging.ALERT_EVENT).count() == 1
    # Not again within a week.
    assert await aging.run_aging_alerts(db) == 0
    # Due again after a week.
    assert await aging.run_aging_alerts(db, now=datetime.now(timezone.utc) + timedelta(days=8)) == 1
