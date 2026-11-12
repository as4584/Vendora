"""Automatic background sync: who is due, isolation of failures, and the kill switch."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.models.integration import EbayToken
from app.services import auto_sync
from app.services.providers.base import SyncRunManager
from app.security.token_encryption import encrypt_token

NOW = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)


def _connect(db, user):
    db.add(EbayToken(user_id=user.id, access_token=encrypt_token("at"), refresh_token=encrypt_token("rt"),
                     expires_at=NOW + timedelta(hours=2)))
    db.commit()


def _ran(db, user, ago):
    run = SyncRunManager.start(db, "ebay", user.id, None, trigger_type="scheduled")
    run.started_at = NOW - ago
    db.commit()


def _job(calls, fail_for=None, minutes=10):
    async def go(db, uid):
        calls.append(uid)
        if fail_for is not None and uid == fail_for:
            raise RuntimeError("eBay down")

    return auto_sync.Job("ebay", EbayToken, go, minutes)


def test_never_synced_is_due(db, test_user):
    _connect(db, test_user)
    calls = []
    assert asyncio.run(auto_sync.run_due(db, NOW, [_job(calls)])) == {"ebay": 1}
    assert calls == [test_user.id]


def test_recent_sync_is_not_due_old_one_is(db, test_user):
    _connect(db, test_user)
    _ran(db, test_user, timedelta(minutes=3))
    calls = []
    asyncio.run(auto_sync.run_due(db, NOW, [_job(calls)]))
    assert calls == []
    _ran(db, test_user, timedelta(minutes=0))  # newest run wins
    asyncio.run(auto_sync.run_due(db, NOW + timedelta(minutes=11), [_job(calls)]))
    assert calls == [test_user.id]


def test_unconnected_users_skipped(db, test_user):
    calls = []
    assert asyncio.run(auto_sync.run_due(db, NOW, [_job(calls)])) == {"ebay": 0}
    assert calls == []


def test_one_failure_does_not_stop_others(db, test_user, second_user):
    _connect(db, test_user)
    _connect(db, second_user)
    calls = []
    result = asyncio.run(auto_sync.run_due(db, NOW, [_job(calls, fail_for=test_user.id)]))
    assert set(calls) == {test_user.id, second_user.id}
    assert result == {"ebay": 1}


def test_kill_switch(db, test_user, monkeypatch):
    monkeypatch.setattr(auto_sync.settings, "AUTO_SYNC_ENABLED", False)
    _connect(db, test_user)
    calls = []
    assert asyncio.run(auto_sync.run_due(db, NOW, [_job(calls)])) == {}
    assert calls == []


def test_batch_limit(db, test_user, second_user, monkeypatch):
    monkeypatch.setattr(auto_sync.settings, "AUTO_SYNC_BATCH", 1)
    _connect(db, test_user)
    _connect(db, second_user)
    calls = []
    asyncio.run(auto_sync.run_due(db, NOW, [_job(calls)]))
    assert len(calls) == 1


def test_real_jobs_cover_every_provider():
    assert {j.provider for j in auto_sync._jobs()} == {"ebay", "stockx", "lightspeed", "square", "clover"}


def test_ebay_job_pulls_orders_then_fees(db, test_user, monkeypatch):
    from app.services import ebay, ebay_insights

    seen = []

    async def fake_sync(db_, uid, trigger_type="manual"):
        seen.append(("orders", trigger_type))

    async def fake_fees(db_, uid, days=90):
        seen.append(("fees", days))
        raise RuntimeError("finances API down")  # must not fail the job

    monkeypatch.setattr(ebay.ebay_service, "sync", fake_sync)
    monkeypatch.setattr(ebay_insights, "sync_finances", fake_fees)
    job = next(j for j in auto_sync._jobs() if j.provider == "ebay")
    asyncio.run(job.run(db, test_user.id))
    assert seen == [("orders", "scheduled"), ("fees", 30)]


@pytest.fixture()
def second_user(db):
    from app.models.user import User

    u = User(email="second@example.com", password_hash="x", business_name="Two")
    db.add(u)
    db.commit()
    return u
