"""RevenueCat (Apple in-app purchase) webhook: auth, idempotency, entitlements."""
import json
import uuid

import pytest

from app.config import settings

SECRET = "rc-test-secret"
URL = "/api/v1/webhooks/revenuecat"


@pytest.fixture(autouse=True)
def rc_secret(monkeypatch):
    monkeypatch.setattr(settings, "REVENUECAT_WEBHOOK_AUTH", SECRET)


def _event(user, event_type, product="com.vendora.pro.monthly", **extra):
    event = {
        "id": uuid.uuid4().hex,
        "type": event_type,
        "app_user_id": str(user.id),
        "product_id": product,
        "expiration_at_ms": 1900000000000,
        **extra,
    }
    return {"api_version": "1.0", "event": event}


def _post(client, body, auth=SECRET):
    return client.post(URL, content=json.dumps(body), headers={"Authorization": auth})


def _me(client, headers):
    return client.get("/api/v1/auth/me", headers=headers).json()


def test_rejects_bad_auth(client, test_user):
    assert _post(client, _event(test_user, "INITIAL_PURCHASE"), auth="nope").status_code == 401


def test_unconfigured_returns_503(client, test_user, monkeypatch):
    monkeypatch.setattr(settings, "REVENUECAT_WEBHOOK_AUTH", "")
    assert _post(client, _event(test_user, "INITIAL_PURCHASE")).status_code == 503


def test_purchase_upgrades_and_expiration_downgrades(client, test_user, auth_headers):
    resp = _post(client, _event(test_user, "INITIAL_PURCHASE"))
    assert resp.status_code == 200 and resp.json()["status"] == "processed"
    assert _me(client, auth_headers)["subscription_tier"] == "pro"

    # Cancelling auto-renew keeps access until expiry.
    _post(client, _event(test_user, "CANCELLATION"))
    assert _me(client, auth_headers)["subscription_tier"] == "pro"

    _post(client, _event(test_user, "EXPIRATION"))
    assert _me(client, auth_headers)["subscription_tier"] == "free"


def test_bearer_prefix_accepted(client, test_user, auth_headers):
    assert _post(client, _event(test_user, "INITIAL_PURCHASE"), auth=f"Bearer {SECRET}").status_code == 200


def test_partner_product_sets_partner(client, test_user, auth_headers):
    _post(client, _event(test_user, "INITIAL_PURCHASE", product="com.vendora.partner.monthly"))
    me = _me(client, auth_headers)
    assert me["subscription_tier"] == "pro" and me["is_partner"] is True


def test_product_change_moves_entitlement(client, test_user, auth_headers):
    _post(client, _event(test_user, "INITIAL_PURCHASE", product="com.vendora.partner.monthly"))
    _post(client, _event(test_user, "PRODUCT_CHANGE", product="com.vendora.partner.monthly",
                         new_product_id="com.vendora.pro.monthly"))
    me = _me(client, auth_headers)
    assert me["subscription_tier"] == "pro" and me["is_partner"] is False


def test_duplicate_event_is_idempotent(client, test_user):
    body = _event(test_user, "INITIAL_PURCHASE")
    assert _post(client, body).json()["status"] == "processed"
    assert _post(client, body).json()["status"] == "already_processed"


def test_unknown_user_and_product_are_noops(client, test_user, auth_headers):
    body = _event(test_user, "INITIAL_PURCHASE")
    body["event"]["app_user_id"] = "$RCAnonymousID:abc"
    assert _post(client, body).json()["status"] == "unknown_user"
    assert _post(client, _event(test_user, "INITIAL_PURCHASE", product="other")).json()["status"] == "unknown_product"
    assert _me(client, auth_headers)["subscription_tier"] == "free"


def test_apple_expiry_keeps_active_stripe_pro(client, test_user, auth_headers):
    stripe_event = {"id": f"evt_{uuid.uuid4().hex}", "type": "customer.subscription.created",
                    "data": {"object": {"id": f"sub_{uuid.uuid4().hex}", "metadata": {"user_id": str(test_user.id)}}}}
    client.post("/api/v1/webhooks/stripe", content=json.dumps(stripe_event))
    _post(client, _event(test_user, "INITIAL_PURCHASE"))
    _post(client, _event(test_user, "EXPIRATION"))
    assert _me(client, auth_headers)["subscription_tier"] == "pro"
