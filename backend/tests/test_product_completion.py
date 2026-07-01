"""Regression coverage for completed subscription, analytics, support, and Lightspeed flows."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.integration import LightspeedToken
from app.models.inventory import InventoryExternalLink, InventoryItem
from app.models.subscription import Subscription
from app.models.support import SupportRequest
from app.models.transaction import Transaction
from app.services import lightspeed as lightspeed_module
from app.services import stripe_service
from app.services import email as email_service
from app.services.lightspeed import lightspeed_service


class TestAdvancedAnalytics:
    def test_free_user_is_gated(self, client, auth_headers):
        response = client.get("/api/v1/dashboard/advanced", headers=auth_headers)
        assert response.status_code == 403

    def test_pro_metrics_and_bounds(self, client, auth_headers, db, test_user):
        test_user.subscription_tier = "pro"
        item = InventoryItem(user_id=test_user.id, name="Sneaker", category="Shoes", quantity=0, status="sold", buy_price=Decimal("20"))
        db.add(item); db.flush()
        now = datetime.now(timezone.utc)
        db.add_all([
            Transaction(user_id=test_user.id, item_id=item.id, method="cash", status="completed", gross_amount=Decimal("100"), fee_amount=0, net_amount=Decimal("95"), quantity=2, created_at=now),
            Transaction(user_id=test_user.id, item_id=item.id, method="cash", status="completed", gross_amount=Decimal("20"), fee_amount=0, net_amount=Decimal("-20"), quantity=1, is_refund=True, created_at=now),
        ])
        db.flush()
        response = client.get("/api/v1/dashboard/advanced?days=2", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        assert data["period_days"] == 7
        assert Decimal(data["revenue"]) == Decimal("100")
        assert Decimal(data["net"]) == Decimal("95")
        assert data["categories"][0]["category"] == "Shoes"
        assert data["categories"][0]["units_sold"] == 2
        assert len(data["daily"]) == 7

    def test_empty_pro_metrics(self, client, auth_headers, db, test_user):
        test_user.subscription_tier = "pro"; db.flush()
        data = client.get("/api/v1/dashboard/advanced?days=999", headers=auth_headers).json()
        assert data["period_days"] == 90
        assert Decimal(data["average_order_value"]) == 0
        assert Decimal(data["sell_through_rate"]) == 0
        assert data["categories"] == []


class TestSubscriptionProduct:
    def test_status_checkout_and_portal_endpoints(self, client, auth_headers, db, test_user, monkeypatch):
        status = client.get("/api/v1/subscriptions/me", headers=auth_headers)
        assert status.json()["status"] == "none"
        monkeypatch.setattr("app.routers.subscriptions.create_subscription_checkout", lambda db, user, plan: {"checkout_url": "https://stripe.test", "session_id": plan})
        monkeypatch.setattr("app.routers.subscriptions.create_billing_portal", lambda db, user: {"portal_url": "https://portal.test"})
        assert client.post("/api/v1/subscriptions/checkout", headers=auth_headers, json={"plan": "partner"}).json()["session_id"] == "partner"
        assert client.post("/api/v1/subscriptions/portal", headers=auth_headers).json()["portal_url"] == "https://portal.test"
        subscription = Subscription(user_id=test_user.id, status="active", stripe_customer_id="cus_1", current_period_end=datetime.now(timezone.utc))
        db.add(subscription); db.flush()
        assert client.get("/api/v1/subscriptions/me", headers=auth_headers).json()["managed_billing"] is True

    def test_checkout_validation_partner_and_existing_customer(self, db, test_user, monkeypatch):
        monkeypatch.setattr(stripe_service, "STRIPE_AVAILABLE", True)
        monkeypatch.setattr(stripe_service.settings, "STRIPE_PRO_PRICE_ID", "price_pro")
        monkeypatch.setattr(stripe_service.settings, "STRIPE_PARTNER_PRICE_ID", "price_partner")
        observed = {}
        stripe = SimpleNamespace(checkout=SimpleNamespace(Session=SimpleNamespace(create=lambda **kwargs: observed.update(kwargs) or SimpleNamespace(url="https://checkout", id="cs_1"))))
        monkeypatch.setattr(stripe_service, "stripe", stripe)
        with pytest.raises(HTTPException): stripe_service.create_subscription_checkout(db, test_user, "invalid")
        result = stripe_service.create_subscription_checkout(db, test_user, "partner")
        assert result["session_id"] == "cs_1"
        assert len(observed["line_items"]) == 2
        assert observed["customer_email"] == test_user.email

        test_user.subscription_tier = "pro"
        db.add(Subscription(user_id=test_user.id, stripe_customer_id="cus_1", status="active")); db.commit()
        stripe_service.create_subscription_checkout(db, test_user, "partner")
        assert observed["customer"] == "cus_1"
        with pytest.raises(HTTPException): stripe_service.create_subscription_checkout(db, test_user, "pro")
        test_user.is_partner = True
        with pytest.raises(HTTPException): stripe_service.create_subscription_checkout(db, test_user, "partner")

    def test_checkout_missing_prices_and_portal_branches(self, db, test_user, monkeypatch):
        monkeypatch.setattr(stripe_service, "STRIPE_AVAILABLE", True)
        monkeypatch.setattr(stripe_service.settings, "STRIPE_PRO_PRICE_ID", "")
        with pytest.raises(HTTPException): stripe_service.create_subscription_checkout(db, test_user)
        monkeypatch.setattr(stripe_service.settings, "STRIPE_PRO_PRICE_ID", "price_pro")
        monkeypatch.setattr(stripe_service.settings, "STRIPE_PARTNER_PRICE_ID", "")
        with pytest.raises(HTTPException): stripe_service.create_subscription_checkout(db, test_user, "partner")
        monkeypatch.setattr(stripe_service, "STRIPE_AVAILABLE", False)
        with pytest.raises(HTTPException): stripe_service.create_billing_portal(db, test_user)
        monkeypatch.setattr(stripe_service, "STRIPE_AVAILABLE", True)
        with pytest.raises(HTTPException): stripe_service.create_billing_portal(db, test_user)
        subscription = Subscription(user_id=test_user.id, stripe_customer_id="cus_portal", status="active")
        db.add(subscription); db.commit()
        monkeypatch.setattr(stripe_service, "stripe", SimpleNamespace(billing_portal=SimpleNamespace(Session=SimpleNamespace(create=lambda **kwargs: SimpleNamespace(url="https://portal")))))
        assert stripe_service.create_billing_portal(db, test_user)["portal_url"] == "https://portal"

    def test_partner_webhook_sets_and_clears_entitlements(self, db, test_user):
        stripe_service.handle_subscription_event(db, "customer.subscription.created", {"object": {"id": "sub_partner", "customer": "cus_partner", "metadata": {"user_id": str(test_user.id), "plan": "partner"}}})
        db.refresh(test_user)
        assert test_user.subscription_tier == "pro" and test_user.is_partner is True
        assert db.query(Subscription).filter_by(user_id=test_user.id).one().stripe_customer_id == "cus_partner"
        stripe_service.handle_subscription_event(db, "customer.subscription.deleted", {"object": {"id": "sub_partner", "metadata": {}}})
        db.refresh(test_user)
        assert test_user.subscription_tier == "free" and test_user.is_partner is False

    def test_cancel_partner_addon_preserves_separate_pro(self, db, test_user):
        test_user.subscription_tier = "pro"
        db.add(Subscription(user_id=test_user.id, stripe_subscription_id="sub_pro", tier="pro", status="active", price_monthly=Decimal("20")))
        db.commit()
        stripe_service.handle_subscription_event(db, "customer.subscription.created", {"object": {"id": "sub_addon", "customer": "cus_partner", "metadata": {"user_id": str(test_user.id), "plan": "partner"}}})
        assert db.query(Subscription).filter_by(user_id=test_user.id).count() == 2
        stripe_service.handle_subscription_event(db, "customer.subscription.deleted", {"object": {"id": "sub_addon", "metadata": {}}})
        db.refresh(test_user)
        assert test_user.subscription_tier == "pro"
        assert test_user.is_partner is False


class TestSupportProduct:
    def test_support_email_escapes_html(self, monkeypatch):
        observed = []
        monkeypatch.setattr(email_service, "_send_email", lambda *args: observed.append(args))
        email_service.send_support_request_email("user@test.com", "<Help>", "Line 1\n<script>", "priority")
        assert "&lt;Help&gt;" in observed[0][3]
        assert "<br>" in observed[0][3]

    def test_standard_and_priority_requests(self, client, auth_headers, db, test_user, monkeypatch):
        sent = []
        monkeypatch.setattr("app.routers.support.send_support_request_email", lambda *args: sent.append(args))
        response = client.post("/api/v1/support", headers=auth_headers, json={"subject": "Need help", "message": "The inventory sync is stuck."})
        assert response.status_code == 201 and response.json()["priority"] == "standard"
        test_user.is_partner = True; db.flush()
        response = client.post("/api/v1/support", headers=auth_headers, json={"subject": "Need help", "message": "The inventory sync is stuck."})
        assert response.json()["priority"] == "priority"
        assert db.query(SupportRequest).filter_by(user_id=test_user.id).count() == 2
        assert len(sent) == 2

    def test_email_failure_keeps_ticket(self, client, auth_headers, db, monkeypatch):
        from app.services.email import EmailDeliveryError
        monkeypatch.setattr("app.routers.support.send_support_request_email", lambda *args: (_ for _ in ()).throw(EmailDeliveryError("down")))
        response = client.post("/api/v1/support", headers=auth_headers, json={"subject": "Need help", "message": "The inventory sync is stuck."})
        assert response.status_code == 201 and response.json()["email_queued"] is False


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code; self._payload = payload or {}; self.text = text
    def json(self): return self._payload


class FakeClient:
    response = FakeResponse()
    calls = []
    def __init__(self, **kwargs): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *args): return None
    async def post(self, url, **kwargs): self.calls.append(("post", url, kwargs)); return self.response
    async def put(self, url, **kwargs): self.calls.append(("put", url, kwargs)); return self.response


class TestLightspeedTwoWay:
    @pytest.mark.asyncio
    async def test_write_create_update_and_errors(self, db, test_user, monkeypatch):
        item = InventoryItem(user_id=test_user.id, name="Bag", sku="B1", upc="123", buy_price=Decimal("4"), quantity=1)
        monkeypatch.setattr(lightspeed_module.httpx, "AsyncClient", FakeClient)
        FakeClient.calls = []; FakeClient.response = FakeResponse(payload={"Item": {"itemID": "ls1", "systemSku": "B1"}})
        assert (await lightspeed_service._write_inventory_item("token", "url", item, create=True))["itemID"] == "ls1"
        await lightspeed_service._write_inventory_item("token", "url/ls1", item, create=False)
        assert [call[0] for call in FakeClient.calls] == ["post", "put"]
        item.expected_sell_price = Decimal("12.50")
        await lightspeed_service._write_inventory_item("token", "url", item, create=True)
        assert FakeClient.calls[-1][2]["json"]["Prices"]["ItemPrice"][0]["amount"] == "12.50"
        FakeClient.response = FakeResponse(500, text="down")
        with pytest.raises(HTTPException): await lightspeed_service._write_inventory_item("token", "url", item, create=True)
        FakeClient.response = FakeResponse(payload={"Item": {}})
        with pytest.raises(HTTPException): await lightspeed_service._write_inventory_item("token", "url", item, create=True)

    @pytest.mark.asyncio
    async def test_push_create_update_bulk_and_disconnect(self, db, test_user, monkeypatch):
        item = InventoryItem(user_id=test_user.id, name="Bag", quantity=1)
        db.add(item); db.flush()
        token = LightspeedToken(user_id=test_user.id, account_id="acc", access_token="access", refresh_token="refresh", expires_at=datetime.now(timezone.utc) + timedelta(hours=1))
        db.add(token); db.commit()
        monkeypatch.setattr(lightspeed_service, "_ensure_valid_token", lambda db, token: _async(token))
        monkeypatch.setattr(lightspeed_service, "_write_inventory_item", lambda *args, **kwargs: _async({"itemID": "ls1", "systemSku": "SYS"}))
        assert await lightspeed_service.push_item(db, test_user.id, item.id) is True
        assert await lightspeed_service.push_item(db, test_user.id, item.id) is False
        result = await lightspeed_service.push_linked_items(db, test_user.id)
        assert result == {"items_updated": 1, "errors_count": 0}
        assert lightspeed_service.disconnect(db, test_user.id) == 1
        assert lightspeed_service.disconnect(db, test_user.id) == 1

    @pytest.mark.asyncio
    async def test_push_failure_branches_and_endpoints(self, client, auth_headers, db, test_user, monkeypatch):
        with pytest.raises(HTTPException): await lightspeed_service.push_item(db, test_user.id, test_user.id)
        token = LightspeedToken(user_id=test_user.id, account_id="acc", access_token="a", refresh_token="r", expires_at=datetime.now(timezone.utc) + timedelta(hours=1))
        db.add(token); db.commit()
        with pytest.raises(HTTPException): await lightspeed_service.push_item(db, test_user.id, test_user.id)
        item = InventoryItem(user_id=test_user.id, name="Bag", quantity=1); db.add(item); db.flush()
        link = InventoryExternalLink(user_id=test_user.id, inventory_item_id=item.id, provider="lightspeed", external_id="ls1"); db.add(link); db.commit()
        async def fail(*args, **kwargs): raise HTTPException(502, "bad")
        monkeypatch.setattr(lightspeed_service, "push_item", fail)
        assert await lightspeed_service.push_linked_items(db, test_user.id) == {"items_updated": 0, "errors_count": 1}

    def test_two_way_endpoints(self, client, auth_headers, test_user, monkeypatch):
        monkeypatch.setattr(lightspeed_service, "push_linked_items", lambda *args: _async({"items_updated": 1, "errors_count": 1}))
        response = client.post("/api/v1/integrations/lightspeed/push", headers=auth_headers)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "partial"
        monkeypatch.setattr(lightspeed_service, "push_item", lambda *args: _async(True))
        response = client.post(f"/api/v1/integrations/lightspeed/items/{test_user.id}/push", headers=auth_headers)
        assert response.json()["items_created"] == 1
        monkeypatch.setattr(lightspeed_service, "disconnect", lambda *args: 3)
        assert client.delete("/api/v1/integrations/lightspeed", headers=auth_headers).json()["links_retained"] == 3


async def _async(value):
    return value


def test_stripe_importerror_fallback(monkeypatch):
    import builtins
    import importlib

    real_import = builtins.__import__
    def blocked(name, *args, **kwargs):
        if name == "stripe":
            raise ImportError("blocked for coverage")
        return real_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", blocked)
    importlib.reload(stripe_service)
    assert stripe_service.STRIPE_AVAILABLE is False
    monkeypatch.setattr(builtins, "__import__", real_import)
    importlib.reload(stripe_service)
