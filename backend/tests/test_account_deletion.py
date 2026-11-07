"""Account deletion (App Store 5.1.1(v)): full path incl. third-party revocation."""
from datetime import datetime, timedelta, timezone

import httpx

from app.config import settings
from app.models.clover import CloverCredential  # noqa: F401
from app.models.google_sheets import GoogleToken
from app.models.integration import EbayToken
from app.models.stockx import StockxToken
from app.models.user import User
from app.security.token_encryption import encrypt_token
from app.services import account_deletion

DELETE_BODY = {"password": "TestPass123", "confirmation": "DELETE"}


def _expiry():
    return datetime.now(timezone.utc) + timedelta(hours=1)


def _connect_everything(db, user):
    db.add(EbayToken(user_id=user.id, access_token=encrypt_token("ebay-at"), refresh_token=encrypt_token("ebay-rt"), expires_at=_expiry()))
    db.add(StockxToken(user_id=user.id, access_token=encrypt_token("sx-at"), refresh_token=encrypt_token("sx-rt"), expires_at=_expiry()))
    db.add(GoogleToken(user_id=user.id, access_token=encrypt_token("g-at"), refresh_token=encrypt_token("g-rt"), expires_at=_expiry()))
    db.flush()


class _Recorder:
    def __init__(self, status_code=200, fail=False):
        self.calls = []
        self.status_code = status_code
        self.fail = fail

    def __call__(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.fail:
            raise httpx.ConnectError("offline")
        return httpx.Response(self.status_code)


def _delete(client, auth_headers):
    return client.request("DELETE", "/api/v1/auth/account", json=DELETE_BODY, headers=auth_headers)


def test_deletion_revokes_google_and_purges_marketplace_tokens(client, auth_headers, test_user, db, monkeypatch):
    _connect_everything(db, test_user)
    recorder = _Recorder()
    monkeypatch.setattr(account_deletion, "http_request", recorder)
    monkeypatch.setattr(settings, "REVENUECAT_SECRET_KEY", "")
    user_id = test_user.id

    assert _delete(client, auth_headers).status_code == 200

    db.expire_all()
    assert db.get(User, user_id) is None
    for model in (EbayToken, StockxToken, GoogleToken):
        assert db.query(model).filter(model.user_id == user_id).count() == 0
    assert recorder.calls == [("POST", account_deletion.GOOGLE_REVOKE_URL, {"data": {"token": "g-rt"}})]


def test_deletion_deletes_revenuecat_customer_when_key_set(client, auth_headers, test_user, db, monkeypatch):
    recorder = _Recorder()
    monkeypatch.setattr(account_deletion, "http_request", recorder)
    monkeypatch.setattr(settings, "REVENUECAT_SECRET_KEY", "sk_test")

    assert _delete(client, auth_headers).status_code == 200

    method, url, kwargs = recorder.calls[0]
    assert method == "DELETE"
    assert url.endswith(f"/v1/subscribers/{test_user.id}")
    assert kwargs["headers"]["Authorization"] == "Bearer sk_test"


def test_provider_outage_never_blocks_deletion(client, auth_headers, test_user, db, monkeypatch):
    _connect_everything(db, test_user)
    monkeypatch.setattr(account_deletion, "http_request", _Recorder(fail=True))
    monkeypatch.setattr(settings, "REVENUECAT_SECRET_KEY", "sk_test")
    user_id = test_user.id

    assert _delete(client, auth_headers).status_code == 200
    db.expire_all()
    assert db.get(User, user_id) is None


def test_revoke_reports_results(db, test_user, monkeypatch):
    _connect_everything(db, test_user)
    monkeypatch.setattr(account_deletion, "http_request", _Recorder(status_code=404))
    monkeypatch.setattr(settings, "REVENUECAT_SECRET_KEY", "sk_test")
    assert account_deletion.revoke_third_party_access(db, test_user) == {"google_revoked": True, "revenuecat_deleted": True}


def test_revoke_without_connections_makes_no_calls(db, test_user, monkeypatch):
    recorder = _Recorder()
    monkeypatch.setattr(account_deletion, "http_request", recorder)
    monkeypatch.setattr(settings, "REVENUECAT_SECRET_KEY", "")
    assert account_deletion.revoke_third_party_access(db, test_user) == {"google_revoked": False, "revenuecat_deleted": False}
    assert recorder.calls == []


def test_unexpected_provider_errors_are_swallowed(db, test_user, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("bug")

    monkeypatch.setattr(account_deletion, "_revoke_google", boom)
    monkeypatch.setattr(account_deletion, "_delete_revenuecat_customer", boom)
    assert account_deletion.revoke_third_party_access(db, test_user) == {"google_revoked": False, "revenuecat_deleted": False}
