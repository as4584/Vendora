"""Regression tests for the 2026-11 security review (docs/security/REVIEW_2026-11.md)."""
import base64
import io
import zipfile

import pytest
from fastapi import HTTPException

from app.config import settings
from app.models.inventory import InventoryItem
from app.models.subscription import WebhookEvent
from app.rate_limit import limiter
from app.services import ebay_listing
from app.services.spreadsheet_import import assert_safe_xlsx_archive, rows_from_bytes

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)
SVG_XSS = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>'


def _item(db, user, front):
    item = InventoryItem(user_id=user.id, name="Photo item", quantity=1, photo_front_url=front)
    db.add(item)
    db.flush()
    return item


def _image_url(item):
    sig = ebay_listing.image_signature(item.id, "front")
    return f"/api/v1/integrations/ebay/images/{item.id}/front/{sig}.jpg"


# ── H1: public signed eBay image URL must never serve active content ─────────

def test_public_image_serves_png_with_sniffed_type(client, db, test_user):
    item = _item(db, test_user, "data:image/png;base64," + base64.b64encode(PNG_1PX).decode())
    resp = client.get(_image_url(item))
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in resp.headers["content-security-policy"]


@pytest.mark.parametrize("header", ["data:image/svg+xml;base64,", "data:image/jpeg;base64,", "data:text/html;base64,"])
def test_public_image_refuses_svg_or_html_payload(client, db, test_user, header):
    item = _item(db, test_user, header + base64.b64encode(SVG_XSS).decode())
    assert client.get(_image_url(item)).status_code == 404


def test_public_image_bad_signature_404(client, db, test_user):
    item = _item(db, test_user, "data:image/png;base64," + base64.b64encode(PNG_1PX).decode())
    url = _image_url(item)[:-8] + "0" * 4 + ".jpg"
    assert client.get(url).status_code == 404


# ── M1: webhooks fail closed outside dev/test ────────────────────────────────

@pytest.mark.parametrize("env", ["production", "staging", "prod"])
def test_stripe_webhook_unsigned_refused_outside_dev(client, db, monkeypatch, env):
    monkeypatch.setattr(settings, "ENVIRONMENT", env)
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", "")
    resp = client.post(
        "/api/v1/webhooks/stripe",
        json={"id": "evt_forged", "type": "customer.subscription.deleted", "data": {"object": {}}},
    )
    assert resp.status_code == 503
    assert db.query(WebhookEvent).filter_by(event_id="evt_forged").count() == 0


@pytest.mark.parametrize("headers,body", [
    ({}, b""),                                          # no signature, empty body
    ({"stripe-signature": "garbage"}, b"{}"),           # malformed signature header
    ({"stripe-signature": "t=1,v1=deadbeef"}, b"not json"),
])
def test_stripe_webhook_malformed_is_400_not_500(client, db, monkeypatch, headers, body):
    """Found live after deploy: a junk POST raised ValueError inside Stripe's
    verifier and surfaced as a 500. Real Stripe deliveries are unaffected."""
    pytest.importorskip("stripe")
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", "whsec_test_secret")
    monkeypatch.setattr("app.routers.webhooks.STRIPE_AVAILABLE", True)
    resp = client.post("/api/v1/webhooks/stripe", content=body, headers=headers)
    assert resp.status_code == 400
    assert db.query(WebhookEvent).count() == 0


@pytest.mark.parametrize("env", ["production", "staging"])
def test_square_webhook_unsigned_refused_outside_dev(client, monkeypatch, env):
    monkeypatch.setattr(settings, "ENVIRONMENT", env)
    monkeypatch.setattr(settings, "SQUARE_WEBHOOK_SIGNATURE_KEY", "")
    resp = client.post(
        "/api/v1/integrations/square/webhook",
        json={"event_id": "e1", "type": "inventory.count.updated", "merchant_id": "m"},
    )
    assert resp.status_code == 503


def test_revenuecat_wrong_auth_is_401(client, monkeypatch):
    monkeypatch.setattr(settings, "REVENUECAT_WEBHOOK_AUTH", "expected-secret-value")
    resp = client.post("/api/v1/webhooks/revenuecat", headers={"Authorization": "Bearer nope"},
                       json={"event": {"id": "x", "type": "INITIAL_PURCHASE"}})
    assert resp.status_code == 401


# ── M2: XLSX zip bomb refused before inflation ───────────────────────────────

def _bomb(size: int) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("xl/worksheets/sheet1.xml", b"\0" * size)
    return buf.getvalue()


def test_xlsx_zip_bomb_rejected():
    content = _bomb(64 * 1024 * 1024)  # 64 MB of zeros -> ~64 KB compressed
    assert len(content) < 1024 * 1024
    with pytest.raises(HTTPException) as exc:
        rows_from_bytes(content, "xlsx")
    assert exc.value.status_code == 413


def test_small_xlsx_archive_passes_guard():
    assert_safe_xlsx_archive(_bomb(1024))


def test_non_zip_passes_guard_for_parser_to_reject():
    assert assert_safe_xlsx_archive(b"not a zip") is None


# ── L/M: brute-forceable auth endpoints are rate limited ─────────────────────

@pytest.mark.parametrize("endpoint", ["login", "refresh_session", "forgot_password", "reset_password", "register"])
def test_auth_endpoints_have_rate_limits(endpoint):
    assert f"app.routers.auth.{endpoint}" in limiter._route_limits


def test_reset_token_is_single_use(client, db, test_user):
    from app.services.auth import create_password_reset_token

    token, token_hash, expires_at = create_password_reset_token()
    test_user.password_reset_token_hash = token_hash
    test_user.password_reset_expires_at = expires_at
    db.flush()
    body = {"token": token, "password": "BrandNewPass1"}
    assert client.post("/api/v1/auth/reset-password", json=body).status_code == 200
    assert client.post("/api/v1/auth/reset-password", json=body).status_code == 400


def test_password_reset_revokes_existing_sessions(client, db, test_user, auth_headers):
    from app.services.auth import create_password_reset_token

    assert client.get("/api/v1/auth/me", headers=auth_headers).status_code == 200
    token, token_hash, expires_at = create_password_reset_token()
    test_user.password_reset_token_hash = token_hash
    test_user.password_reset_expires_at = expires_at
    db.flush()
    assert client.post("/api/v1/auth/reset-password", json={"token": token, "password": "BrandNewPass1"}).status_code == 200
    assert client.get("/api/v1/auth/me", headers=auth_headers).status_code == 401


def test_jwt_alg_none_rejected(client, test_user):
    import jwt as pyjwt

    forged = pyjwt.encode({"sub": str(test_user.id), "typ": "access", "sid": "x"}, key=None, algorithm="none")
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401
