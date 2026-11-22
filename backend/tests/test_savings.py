"""GET /api/v1/dashboard/savings — work the integrations did this month."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.models.provider import ProviderSyncRun
from app.models.transaction import Transaction

URL = "/api/v1/dashboard/savings"


def _run(db, user, started_at, **counts):
    db.add(ProviderSyncRun(provider="ebay", user_id=user.id, started_at=started_at, status="completed", **counts))


def test_counts_this_months_runs_and_fees(client, db, test_user, auth_headers):
    now = datetime.now(timezone.utc)
    _run(db, test_user, now, items_imported=10, transactions_imported=6, items_updated=4)
    _run(db, test_user, now - timedelta(days=40), items_imported=99)  # last month or earlier
    db.add_all([
        Transaction(user_id=test_user.id, method="card", gross_amount=Decimal("100"), fee_amount=Decimal("13.60"),
                    net_amount=Decimal("86.40")),
        Transaction(user_id=test_user.id, method="cash", gross_amount=Decimal("10"), fee_amount=Decimal("1.00"),
                    net_amount=Decimal("9"), is_refund=True),
    ])
    db.flush()
    body = client.get(URL, headers=auth_headers).json()
    if now.day == 1 and now.hour == 0:
        return  # month boundary race; nothing meaningful to assert
    assert body["items_imported"] == 10
    assert body["sales_imported"] == 6
    assert body["stock_updates"] == 4
    assert body["minutes_saved"] == round(10 * 3 + 6 * 2 + 4 * 0.5)
    assert Decimal(body["fees_tracked"]) == Decimal("13.60")


def test_zero_for_new_users(client, auth_headers):
    body = client.get(URL, headers=auth_headers).json()
    assert body["minutes_saved"] == 0 and body["items_imported"] == 0
    assert Decimal(body["fees_tracked"]) == 0


def test_other_users_runs_are_excluded(client, db, second_user, auth_headers):
    _run(db, second_user, datetime.now(timezone.utc), items_imported=50)
    db.flush()
    assert client.get(URL, headers=auth_headers).json()["items_imported"] == 0


def test_requires_auth(client):
    assert client.get(URL).status_code == 401
