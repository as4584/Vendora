"""OAuth callbacks: native returns via vendora://, web returns via a popup page."""
from datetime import datetime, timedelta, timezone

import pytest
import jwt

from app.config import settings
from app.services.ebay import ebay_service
from app.services.lightspeed import lightspeed_service
from app.services.oauth_return import finish_response, return_target_for, state_return_target
from app.services.stockx import stockx_service


@pytest.fixture()
def ebay_stubbed(monkeypatch):
    async def exchange(code):
        return {"access_token": "a", "refresh_token": "r",
                "expires_at": datetime.now(timezone.utc) + timedelta(hours=1)}

    async def username(token):
        return "seller1"

    monkeypatch.setattr(ebay_service, "exchange_authorization_code", exchange)
    monkeypatch.setattr(ebay_service, "fetch_username", username)
    monkeypatch.setattr(ebay_service, "upsert_token", lambda *a, **k: None)


def _claims(state):
    state = state.split("state=", 1)[-1]
    return jwt.decode(state, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])


def test_return_target_mapping():
    assert return_target_for("web") == "web"
    assert return_target_for("WEB") == "web"
    assert return_target_for(None) == "app"
    assert return_target_for("ios") == "app"
    assert state_return_target("not-a-jwt") == "app"


def test_ebay_native_callback_keeps_deep_link(client, test_user, ebay_stubbed):
    state = ebay_service.build_state(test_user.id)
    resp = client.get("/api/v1/integrations/ebay/callback",
                      params={"code": "c", "state": state}, follow_redirects=False)
    assert resp.status_code == 303
    assert resp.headers["location"] == "vendora://settings?integration=ebay&status=connected"


def test_ebay_web_callback_returns_popup_page(client, test_user, ebay_stubbed):
    state = ebay_service.build_state(test_user.id, ret="web")
    resp = client.get("/api/v1/integrations/ebay/callback",
                      params={"code": "c", "state": state}, follow_redirects=False)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    body = resp.text
    assert "vendora://" not in body
    assert "postMessage" in body and '"resqlo-oauth"' in body
    assert "window.close()" in body
    assert f"{settings.WEB_APP_URL}/settings?integration=ebay&status=connected" in body
    assert "frame-ancestors 'none'" in resp.headers["content-security-policy"]


def test_callback_query_param_cannot_force_web(client, test_user, ebay_stubbed):
    """The return target comes only from the signed state."""
    state = ebay_service.build_state(test_user.id)
    resp = client.get("/api/v1/integrations/ebay/callback",
                      params={"code": "c", "state": state, "return": "web", "platform": "web"},
                      follow_redirects=False)
    assert resp.status_code == 303 and resp.headers["location"].startswith("vendora://")


def test_tampered_state_rejected(client, test_user, ebay_stubbed):
    state = ebay_service.build_state(test_user.id)
    forged = jwt.encode({**_claims(state), "ret": "web"}, "wrong-key-that-is-long-enough-for-hs256!", algorithm=settings.ALGORITHM)
    resp = client.get("/api/v1/integrations/ebay/callback",
                      params={"code": "c", "state": forged}, follow_redirects=False)
    assert resp.status_code == 400


def test_connect_endpoints_sign_platform_into_state(client, auth_headers, monkeypatch):
    def as_url(state, *a, **k):
        return f"https://auth.example.test/?state={state}"

    monkeypatch.setattr(ebay_service, "authorization_url", as_url)
    monkeypatch.setattr(lightspeed_service, "authorization_url", as_url)
    monkeypatch.setattr(stockx_service, "authorization_url", as_url)
    for path in ("/api/v1/integrations/ebay/connect",
                 "/api/v1/integrations/lightspeed/connect",
                 "/api/v1/integrations/stockx/connect"):
        web = client.get(path, params={"platform": "web"}, headers=auth_headers)
        assert web.status_code == 200, (path, web.text)
        assert _claims(web.json()["authorization_url"])["ret"] == "web"
        native = client.get(path, headers=auth_headers).json()["authorization_url"]
        assert _claims(native)["ret"] == "app"


def test_lightspeed_and_stockx_web_return(client, test_user, monkeypatch):
    async def ls_exchange(code):
        return {"account_id": "acc", "access_token": "a", "refresh_token": "r",
                "expires_at": datetime.now(timezone.utc) + timedelta(hours=1)}

    monkeypatch.setattr(lightspeed_service, "exchange_authorization_code", ls_exchange)
    monkeypatch.setattr(lightspeed_service, "upsert_token", lambda *a, **k: None)
    state = lightspeed_service.build_state(test_user.id, ret="web")
    resp = client.get("/api/v1/integrations/lightspeed/callback",
                      params={"code": "c", "state": state}, follow_redirects=False)
    assert resp.status_code == 200 and "integration=lightspeed" in resp.text

    state = stockx_service.build_state(test_user.id, ret="web")
    resp = client.get("/api/v1/integrations/stockx/callback",
                      params={"error": "access_denied", "state": state}, follow_redirects=False)
    assert resp.status_code == 200 and "status=denied" in resp.text
    native = stockx_service.build_state(test_user.id)
    resp = client.get("/api/v1/integrations/stockx/callback",
                      params={"error": "access_denied", "state": native}, follow_redirects=False)
    assert resp.headers["location"] == "vendora://settings?integration=stockx&status=denied"


def test_finish_response_escapes_script_breakout():
    state = ebay_service.build_state(__import__("uuid").uuid4(), ret="web")
    body = finish_response("</script><b>", "connected", state).body.decode()
    assert "</script><b>" not in body
