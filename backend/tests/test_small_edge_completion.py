"""Small defensive branches that otherwise hide behind integration happy paths."""
from datetime import datetime, timedelta, timezone
import importlib
import sys
from types import SimpleNamespace
import uuid

from cryptography.fernet import Fernet
import jwt
from sqlalchemy.exc import IntegrityError
import pytest

from app.config import settings
from app import database
from app.models.integration import LightspeedToken
from app.security import token_encryption
from app.services.auth import create_access_token, decode_access_token
from app.services.feature_flags import is_feature_enabled
from app.services.tester_access import is_tester_email
from app.services.providers.base import claim_webhook_event
from app.services.providers.base import ProviderAdapter
from app.services.profit import get_revenue, get_refund_total
from app.services.inventory import restore_stock
from app.services.tester_access import apply_tester_entitlements
from app.models.inventory import InventoryItem
from app.models.provider import ReconciliationIssue
from app.routers import auth as auth_router
from app.routers import integrations as integrations_router
from app.schemas.user import PasswordResetConfirm


def test_auth_rejects_missing_subject_and_missing_user(client):
    missing_subject = jwt.encode(
        {"typ": "access", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {missing_subject}"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid token payload."

    missing_user = create_access_token({"sub": str(uuid.uuid4())})
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {missing_user}"})
    assert response.status_code == 401
    assert response.json()["detail"] == "User not found or account deleted."


def test_non_access_jwt_is_rejected():
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "typ": "refresh", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )
    assert decode_access_token(token) is None


def test_lightspeed_expiration_helper():
    token = LightspeedToken(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1))
    assert token.is_expired() is True


def test_dedicated_provider_encryption_key(monkeypatch):
    monkeypatch.setattr(settings, "PROVIDER_TOKEN_KEY", Fernet.generate_key().decode())
    token_encryption._fernet.cache_clear()
    encrypted = token_encryption.encrypt_token("secret")
    assert token_encryption.decrypt_token(encrypted) == "secret"
    token_encryption._fernet.cache_clear()


def test_partner_tester_and_missing_invoice_edges(client, auth_headers):
    assert is_feature_enabled("seller_page", "pro", is_partner=False) is False
    assert is_tester_email(None) is False
    response = client.post(
        "/api/v1/invoices",
        json={
            "customer_name": "Missing Item Buyer",
            "items": [{
                "description": "Missing",
                "quantity": 1,
                "unit_price": "10.00",
                "inventory_item_id": "00000000-0000-0000-0000-000000000000",
            }],
        },
        headers=auth_headers,
    )
    assert response.status_code == 404


def test_provider_webhook_concurrent_insert_returns_winner():
    winner = object()

    class Query:
        def __init__(self, after_race=False):
            self.after_race = after_race

        def filter_by(self, **kwargs):
            return self

        def first(self):
            return winner if self.after_race else None

        def one(self):
            return winner

    class Nested:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            raise IntegrityError("insert", {}, Exception("duplicate"))

    calls = {"query": 0}

    class DB:
        def query(self, *args):
            calls["query"] += 1
            return Query(after_race=calls["query"] > 1)

        def begin_nested(self):
            return Nested()

        def add(self, value):
            return None

        def flush(self):
            return None

    event, created = claim_webhook_event(DB(), "square", "evt-race", "catalog.updated", "{}")
    assert event is winner
    assert created is False


def test_database_sqlite_configuration_branch(monkeypatch):
    original = settings.DATABASE_URL
    try:
        monkeypatch.setattr(settings, "DATABASE_URL", "sqlite:///:memory:")
        importlib.reload(database)
        assert database.connect_args == {"check_same_thread": False}
    finally:
        monkeypatch.setattr(settings, "DATABASE_URL", original)
        importlib.reload(database)


def test_reset_password_normalizes_naive_expiry(monkeypatch):
    user = SimpleNamespace(
        id=uuid.uuid4(),
        password_reset_expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=5),
        password_hash="old",
        password_reset_token_hash="hash",
    )

    class Query:
        def filter(self, *args):
            return self

        def first(self):
            return user

    db = SimpleNamespace(
        query=lambda *args: Query(),
        add=lambda value: None,
        commit=lambda: None,
    )
    monkeypatch.setattr(auth_router, "hash_password_reset_token", lambda token: "hash")
    monkeypatch.setattr(auth_router, "hash_password", lambda password: "new-hash")
    monkeypatch.setattr(auth_router, "revoke_all_sessions", lambda *args: None)
    response = auth_router.reset_password(
        PasswordResetConfirm(token="a" * 32, password="NewPassword2"),
        db=db,
    )
    assert response.message.startswith("Your password")
    assert user.password_hash == "new-hash"


@pytest.mark.asyncio
async def test_retry_rejects_provider_outside_runtime_map():
    run = SimpleNamespace(provider="future-provider")

    class Query:
        def filter(self, *args):
            return self

        def first(self):
            return run

    db = SimpleNamespace(query=lambda *args: Query())
    user = SimpleNamespace(id=uuid.uuid4())
    with pytest.raises(Exception) as exc:
        await integrations_router.retry_sync_run(uuid.uuid4(), db=db, current_user=user)
    assert getattr(exc.value, "status_code", None) == 400


def test_stripe_import_configuration_branch(monkeypatch):
    from app.services import stripe_service

    original_key = settings.STRIPE_SECRET_KEY
    fake = SimpleNamespace(api_key=None)
    try:
        monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_coverage")
        monkeypatch.setitem(sys.modules, "stripe", fake)
        importlib.reload(stripe_service)
        assert stripe_service.STRIPE_AVAILABLE is True
        assert fake.api_key == "sk_test_coverage"
    finally:
        monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", original_key)
        sys.modules.pop("stripe", None)
        importlib.reload(stripe_service)


def test_profit_since_filters_and_stock_restore_branches(db, test_user):
    since = datetime.now(timezone.utc) - timedelta(days=1)
    assert get_revenue(db, test_user.id, since=since) == 0
    assert get_refund_total(db, test_user.id, since=since) == 0
    assert get_revenue(db, test_user.id) == 0
    assert get_refund_total(db, test_user.id) == 0
    item = InventoryItem(user_id=test_user.id, name="Restore branch", quantity=1, status="in_stock")
    db.add(item)
    db.flush()
    entry = restore_stock(
        db, item, 1, "refund", "test", "source", idempotency_key=None
    )
    assert entry.quantity_after == 2
    assert item.status == "in_stock"


def test_provider_resolution_without_note_and_tester_partial_entitlements(db, test_user):
    issue = ReconciliationIssue(
        provider="square",
        user_id=test_user.id,
        issue_type="unknown",
        severity="warning",
        status="open",
    )
    db.add(issue)
    db.flush()
    ProviderAdapter.resolve_issue(db, issue, resolution_note=None)
    assert issue.status == "resolved" and issue.resolution_note is None

    test_user.email = "management.donxera@gmail.com"
    test_user.subscription_tier = "pro"
    test_user.is_partner = False
    assert apply_tester_entitlements(test_user) is True
    assert test_user.is_partner is True
    assert apply_tester_entitlements(test_user) is False
