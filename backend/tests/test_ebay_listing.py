"""eBay listing write-back, outbox, order stock idempotency and comps.

All eBay HTTP is mocked with httpx.MockTransport (sandbox hosts); no real calls.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import httpx
import pytest

from app.models.integration import EbayToken
from app.models.inventory import InventoryExternalLink, InventoryItem, InventoryStockLedger
from app.models.provider_outbox import ProviderOutbox
from app.models.provider import ReconciliationIssue
from app.security.token_encryption import encrypt_token
from app.services import ebay_listing, outbox
from app.services.ebay import ebay_service

PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="


class FakeEbay:
    """Route table: (METHOD, path-substring) -> list of responses (last one repeats)."""

    def __init__(self):
        self.routes: dict = {}
        self.calls: list[httpx.Request] = []

    def on(self, method, path, *responses):
        self.routes[(method, path)] = list(responses)
        return self

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        best = None
        path = request.url.path
        for (m, p), resps in self.routes.items():
            if m != request.method or p not in path:
                continue
            score = (path.endswith(p), len(p))  # suffix matches win, then the longest
            if best is None or score > best[0]:
                best = (score, resps)
        if best is None:
            return httpx.Response(404, json={"errors": [{"errorId": 1, "message": "unmocked"}]})
        resps = best[1]
        r = resps.pop(0) if len(resps) > 1 else resps[0]
        status, body = r
        return httpx.Response(status, json=body) if body is not None else httpx.Response(status)

    def paths(self, method=None):
        return [c.url.path for c in self.calls if method is None or c.method == method]

    def body(self, method, path):
        for c in self.calls:
            if c.method == method and path in c.url.path:
                return json.loads(c.content or b"{}")
        return None


def happy(fake: FakeEbay) -> FakeEbay:
    return (
        fake.on("POST", "/identity/v1/oauth2/token", (200, {"access_token": "app-tok", "expires_in": 7200}))
        .on("GET", "/sell/account/v1/fulfillment_policy", (200, {"fulfillmentPolicies": [{"fulfillmentPolicyId": "F1"}]}))
        .on("GET", "/sell/account/v1/payment_policy", (200, {"paymentPolicies": [{"paymentPolicyId": "P1"}]}))
        .on("GET", "/sell/account/v1/return_policy", (200, {"returnPolicies": [{"returnPolicyId": "R1"}]}))
        .on("GET", "/sell/inventory/v1/location", (200, {"locations": []}))
        .on("POST", "/sell/inventory/v1/location/", (204, None))
        .on("GET", "get_default_category_tree_id", (200, {"categoryTreeId": "0"}))
        .on("GET", "get_category_suggestions", (200, {"categorySuggestions": [{"category": {"categoryId": "15709"}}]}))
        .on("PUT", "/sell/inventory/v1/inventory_item/", (204, None))
        .on("POST", "/sell/inventory/v1/offer", (201, {"offerId": "OFFER1"}))
        .on("POST", "/publish", (200, {"listingId": "LIST1"}))
        .on("PUT", "/sell/inventory/v1/offer/", (204, None))
        .on("POST", "/bulk_update_price_quantity", (200, {"responses": [{"statusCode": 200}]}))
        .on("POST", "/withdraw", (200, {"listingId": "LIST1"}))
    )


@pytest.fixture()
def fake(monkeypatch):
    f = FakeEbay()
    monkeypatch.setattr(ebay_service, "transport", httpx.MockTransport(f.handler))
    monkeypatch.setattr(ebay_service, "env", "sandbox")
    monkeypatch.setattr(ebay_service, "client_id", "app-id")
    monkeypatch.setattr(ebay_service, "client_secret", "cert-id")
    monkeypatch.setattr(ebay_service, "runame", "RuName")
    monkeypatch.setattr(ebay_listing.ebay_http, "rate_limit_sleep", 0)
    ebay_listing.ebay_http.reset_app_token()
    return f


@pytest.fixture()
def token(db, test_user):
    t = EbayToken(
        user_id=test_user.id, account_id="seller1",
        access_token=encrypt_token("user-tok"), refresh_token=encrypt_token("refresh-tok"),
        expires_at=datetime.now(timezone.utc) + timedelta(hours=2),
        scopes=" ".join(ebay_service.requested_scopes),
    )
    db.add(t)
    test_user.business_address = "1 Main St, Clifton, NJ 07011"
    db.flush()
    return t


@pytest.fixture()
def item(db, test_user):
    i = InventoryItem(
        user_id=test_user.id, name="Jordan 1 Retro High Chicago", size="10", color="Red",
        condition="new", quantity=3, buy_price=Decimal("150.00"), photo_front_url=PHOTO,
        custom_attributes={"brand": "Nike", "style_code": "DZ5485-612"},
    )
    db.add(i)
    db.flush()
    return i


def _link(db, item):
    return db.query(InventoryExternalLink).filter_by(inventory_item_id=item.id, provider="ebay").one_or_none()


def _list(client, auth_headers, item, **kw):
    body = {"item_id": str(item.id), "price": "250.00", **kw}
    return client.post("/api/v1/integrations/ebay/listings", json=body, headers=auth_headers)


class TestCreateListing:
    def test_full_flow(self, client, auth_headers, db, token, item, fake):
        happy(fake)
        r = _list(client, auth_headers, item, quantity=2)
        assert r.status_code == 201, r.text
        data = r.json()
        assert data["listed"] and data["listing_id"] == "LIST1" and data["offer_id"] == "OFFER1"
        assert data["url"] == "https://sandbox.ebay.com/itm/LIST1"
        inv = fake.body("PUT", "/inventory_item/")
        assert inv["condition"] == "NEW"
        assert inv["availability"]["shipToLocationAvailability"]["quantity"] == 2
        aspects = inv["product"]["aspects"]
        assert aspects["Brand"] == ["Nike"] and aspects["US Shoe Size"] == ["10"]
        assert aspects["Style Code"] == ["DZ5485-612"] and aspects["Color"] == ["Red"]
        assert "/integrations/ebay/images/" in inv["product"]["imageUrls"][0]
        offer = fake.body("POST", "/sell/inventory/v1/offer")
        assert offer["categoryId"] == "15709" and offer["format"] == "FIXED_PRICE"
        assert offer["marketplaceId"] == "EBAY_US"
        assert offer["pricingSummary"]["price"] == {"value": "250.00", "currency": "USD"}
        assert offer["listingPolicies"] == {"fulfillmentPolicyId": "F1", "paymentPolicyId": "P1", "returnPolicyId": "R1"}
        assert offer["merchantLocationKey"] == "resqlo-default"
        loc = fake.body("POST", "/location/")
        assert loc["location"]["address"]["postalCode"] == "07011"
        link = _link(db, item)
        assert link.listing_status == "active" and link.listed_quantity == 2
        assert link.listed_price == Decimal("250.00")
        db.refresh(item)
        assert item.status == "listed"
        db.refresh(token)
        assert token.merchant_location_key == "resqlo-default"

    def test_existing_location_reused(self, client, auth_headers, db, token, item, fake):
        happy(fake).on("GET", "/sell/inventory/v1/location", (200, {"locations": [{"merchantLocationKey": "home"}]}))
        assert _list(client, auth_headers, item).status_code == 201
        assert fake.body("POST", "/sell/inventory/v1/offer")["merchantLocationKey"] == "home"
        assert not any("/location/" in p for p in fake.paths("POST"))

    def test_missing_policies_actionable(self, client, auth_headers, token, item, fake):
        happy(fake).on("GET", "/sell/account/v1/return_policy", (200, {"returnPolicies": []}))
        fake.on("GET", "/sell/account/v1/payment_policy", (400, {"errors": [{"errorId": 20403, "message": "not opted in"}]}))
        r = _list(client, auth_headers, item)
        assert r.status_code == 409
        d = r.json()["detail"]
        assert d["error"] == "ebay_policies_missing" and set(d["missing"]) == {"payment", "return"}
        assert "Business policies" in d["message"]
        assert not fake.paths("PUT")

    def test_not_connected(self, client, auth_headers, item, fake):
        r = _list(client, auth_headers, item)
        assert r.status_code == 409 and r.json()["detail"]["error"] == "ebay_not_connected"

    def test_readonly_connection_needs_reconnect(self, client, auth_headers, db, token, item, fake):
        token.scopes = "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly"
        db.flush()
        r = _list(client, auth_headers, item)
        assert r.json()["detail"]["error"] == "ebay_reconnect_required"

    def test_photo_required(self, client, auth_headers, db, token, item, fake):
        item.photo_front_url = None
        db.flush()
        r = _list(client, auth_headers, item)
        assert r.status_code == 422 and r.json()["detail"]["error"] == "photo_required"

    def test_location_required_without_zip(self, client, auth_headers, db, test_user, token, item, fake):
        happy(fake)
        test_user.business_address = None
        db.flush()
        r = _list(client, auth_headers, item)
        assert r.json()["detail"]["error"] == "ebay_location_required"
        assert _list(client, auth_headers, item, postal_code="07011").status_code == 201

    def test_taxonomy_failure_falls_back_to_sneakers(self, client, auth_headers, token, item, fake):
        happy(fake).on("GET", "get_category_suggestions", (500, {}))
        assert _list(client, auth_headers, item).status_code == 201
        assert fake.body("POST", "/sell/inventory/v1/offer")["categoryId"] == "15709"

    def test_non_footwear_without_category_errors(self, client, auth_headers, db, token, item, fake):
        happy(fake).on("GET", "get_category_suggestions", (200, {"categorySuggestions": []}))
        item.name, item.custom_attributes = "Pokemon Charizard card", {}
        db.flush()
        r = _list(client, auth_headers, item)
        assert r.json()["detail"]["error"] == "category_required"
        assert _list(client, auth_headers, item, category_id="183454").status_code == 201

    def test_token_refresh_on_expiry_and_401(self, client, auth_headers, db, token, item, fake):
        happy(fake)
        token.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.flush()
        fake.on("POST", "/identity/v1/oauth2/token", (200, {"access_token": "new-tok", "expires_in": 7200}))
        fake.on("GET", "/sell/account/v1/fulfillment_policy",
                (401, {}), (200, {"fulfillmentPolicies": [{"fulfillmentPolicyId": "F1"}]}))
        assert _list(client, auth_headers, item).status_code == 201
        token_calls = [c for c in fake.calls if "oauth2/token" in c.url.path]
        assert len(token_calls) >= 2  # expiry refresh + 401 refresh
        assert any(c.headers["Authorization"] == "Bearer new-tok" for c in fake.calls)

    def test_publish_failure_keeps_offer_for_retry(self, client, auth_headers, db, token, item, fake):
        happy(fake).on("POST", "/publish", (400, {"errors": [{"errorId": 25007, "message": "Bad shipping"}]}),
                       (200, {"listingId": "LIST2"}))
        r = _list(client, auth_headers, item)
        assert r.status_code == 409 and "Bad shipping" in r.json()["detail"]["message"]
        link = _link(db, item)
        assert link.offer_id == "OFFER1" and link.listing_status == "error"
        r = _list(client, auth_headers, item)
        assert r.status_code == 201 and r.json()["listing_id"] == "LIST2"
        assert fake.paths("POST").count("/sell/inventory/v1/offer") == 1  # offer reused via PUT

    def test_existing_offer_25002_reused(self, client, auth_headers, token, item, fake):
        happy(fake).on("POST", "/sell/inventory/v1/offer",
                       (400, {"errors": [{"errorId": 25002, "message": "exists"}]}))
        fake.on("GET", "/sell/inventory/v1/offer", (200, {"offers": [{"offerId": "OLD"}]}))
        r = _list(client, auth_headers, item)
        assert r.status_code == 201 and r.json()["offer_id"] == "OLD"

    def test_already_listed_and_out_of_stock(self, client, auth_headers, db, token, item, fake):
        happy(fake)
        assert _list(client, auth_headers, item).status_code == 201
        assert _list(client, auth_headers, item).json()["detail"]["error"] == "already_listed"
        item2 = InventoryItem(user_id=item.user_id, name="x", quantity=0, photo_front_url=PHOTO)
        db.add(item2)
        db.flush()
        assert _list(client, auth_headers, item2).json()["detail"]["error"] == "out_of_stock"

    def test_invalid_condition(self, client, auth_headers, token, item, fake):
        happy(fake)
        r = _list(client, auth_headers, item, condition="mint-ish")
        assert r.status_code == 422

    def test_ebay_5xx_maps_to_502(self, client, auth_headers, token, item, fake):
        happy(fake).on("PUT", "/sell/inventory/v1/inventory_item/", (503, {}))
        assert _list(client, auth_headers, item).status_code == 502


class TestReviseAndEnd:
    def _listed(self, client, auth_headers, item, fake):
        happy(fake)
        assert _list(client, auth_headers, item, quantity=2).status_code == 201

    def test_update_price(self, client, auth_headers, db, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        r = client.patch(f"/api/v1/integrations/ebay/listings/{item.id}", json={"price": "230.5"}, headers=auth_headers)
        assert r.status_code == 200 and r.json()["price"] == "230.50"
        req = fake.body("POST", "/bulk_update_price_quantity")["requests"][0]
        assert req["offers"][0]["price"] == {"value": "230.50", "currency": "USD"}
        assert "availableQuantity" not in req["offers"][0]

    def test_update_quantity_capped_by_stock(self, client, auth_headers, db, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        r = client.patch(f"/api/v1/integrations/ebay/listings/{item.id}", json={"quantity": 9}, headers=auth_headers)
        assert r.status_code == 200
        req = fake.body("POST", "/bulk_update_price_quantity")["requests"][0]
        assert req["offers"][0]["availableQuantity"] == 3

    def test_bulk_update_item_error(self, client, auth_headers, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        fake.on("POST", "/bulk_update_price_quantity",
                (200, {"responses": [{"statusCode": 400, "errors": [{"message": "Price too low"}]}]}))
        r = client.patch(f"/api/v1/integrations/ebay/listings/{item.id}", json={"price": "1"}, headers=auth_headers)
        assert r.status_code == 409 and "Price too low" in r.json()["detail"]["message"]

    def test_end_listing(self, client, auth_headers, db, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        r = client.delete(f"/api/v1/integrations/ebay/listings/{item.id}", headers=auth_headers)
        assert r.status_code == 200 and r.json()["status"] == "ended" and not r.json()["listed"]
        db.refresh(item)
        assert item.status == "in_stock"
        r = client.get(f"/api/v1/integrations/ebay/listings/{item.id}", headers=auth_headers)
        assert r.json()["status"] == "ended"
        assert client.delete(f"/api/v1/integrations/ebay/listings/{item.id}", headers=auth_headers).status_code == 404

    def test_end_already_withdrawn_is_ok(self, client, auth_headers, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        fake.on("POST", "/withdraw", (400, {"errors": [{"errorId": 25713, "message": "not published"}]}))
        assert client.delete(f"/api/v1/integrations/ebay/listings/{item.id}", headers=auth_headers).status_code == 200

    def test_relist_after_end_reuses_offer(self, client, auth_headers, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        client.delete(f"/api/v1/integrations/ebay/listings/{item.id}", headers=auth_headers)
        assert _list(client, auth_headers, item).status_code == 201
        assert fake.paths("POST").count("/sell/inventory/v1/offer") == 1

    def test_other_user_cannot_touch(self, client, auth_headers, second_auth_headers, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        r = client.delete(f"/api/v1/integrations/ebay/listings/{item.id}", headers=second_auth_headers)
        assert r.status_code == 404


class TestDoubleSellPrevention:
    def _listed(self, client, auth_headers, item, fake, qty=2):
        happy(fake)
        assert _list(client, auth_headers, item, quantity=qty).status_code == 201

    def _jobs(self, db, item):
        return db.query(ProviderOutbox).filter_by(inventory_item_id=item.id).all()

    def test_pos_sale_enqueues_in_same_txn_and_pushes(self, client, auth_headers, db, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        r = client.post("/api/v1/transactions", json={
            "item_id": str(item.id), "method": "cash", "gross_amount": "250.00", "quantity": 2,
        }, headers=auth_headers)
        assert r.status_code in (200, 201), r.text
        jobs = self._jobs(db, item)
        assert len(jobs) == 1 and jobs[0].status == "pending"

    async def test_outbox_pushes_min_of_cap_and_stock(self, client, auth_headers, db, token, item, fake):
        self._listed(client, auth_headers, item, fake, qty=2)
        from app.services.inventory import deduct_stock
        deduct_stock(db, item, 2, "sale", "transaction", "t1", idempotency_key="t1")
        db.commit()
        assert len(self._jobs(db, item)) == 1
        assert await outbox.process_outbox(db) == 1
        req = fake.body("POST", "/bulk_update_price_quantity")["requests"][0]
        assert req["offers"][0]["availableQuantity"] == 1  # min(cap 2, stock 1)
        assert self._jobs(db, item)[0].status == "done"

    async def test_sold_out_withdraws(self, client, auth_headers, db, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        from app.services.inventory import deduct_stock
        deduct_stock(db, item, 3, "sale", "invoice", "inv1", idempotency_key="inv1")
        db.commit()
        await outbox.process_outbox(db)
        assert "/withdraw" in " ".join(fake.paths("POST"))
        assert _link(db, item).listing_status == "ended"

    async def test_coalesces_and_idempotent(self, client, auth_headers, db, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        from app.services.inventory import deduct_stock, restore_stock
        deduct_stock(db, item, 1, "sale", "transaction", "a", idempotency_key="a")
        deduct_stock(db, item, 1, "sale", "transaction", "a", idempotency_key="a")  # replay
        restore_stock(db, item, 1, "refund", "transaction", "r", idempotency_key="r")
        db.commit()
        assert len(self._jobs(db, item)) == 1
        await outbox.process_outbox(db)
        await outbox.process_outbox(db)
        assert fake.paths("POST").count("/sell/inventory/v1/bulk_update_price_quantity") == 1

    async def test_retry_with_backoff_then_failed_then_manual_retry(self, client, auth_headers, db, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        fake.on("POST", "/bulk_update_price_quantity", (500, {}))
        from app.services.inventory import deduct_stock
        deduct_stock(db, item, 1, "sale", "transaction", "b", idempotency_key="b")
        db.commit()
        assert await outbox.process_outbox(db) == 1
        job = self._jobs(db, item)[0]
        assert job.status == "pending" and job.attempts == 1
        assert job.next_attempt_at > datetime.now(timezone.utc) + timedelta(seconds=20)
        assert job.last_error
        assert await outbox.process_outbox(db) == 0  # not due yet
        for _ in range(job.max_attempts - 1):
            job.next_attempt_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            db.commit()
            await outbox.process_outbox(db)
            db.refresh(job)
        assert job.status == "failed" and job.next_attempt_at is None
        r = client.get("/api/v1/integrations/outbox", headers=auth_headers)
        assert r.status_code == 200 and r.json()[0]["item_name"] == item.name
        assert r.json()[0]["provider"] == "ebay" and r.json()[0]["action"] == "sync_quantity"
        assert client.get("/api/v1/integrations/outbox?provider=stockx", headers=auth_headers).json() == []
        fake.on("POST", "/bulk_update_price_quantity", (200, {"responses": [{"statusCode": 200}]}))
        r = client.post(f"/api/v1/integrations/outbox/{job.id}/retry", headers=auth_headers)
        assert r.status_code == 200 and r.json()["status"] == "done"
        assert client.post(f"/api/v1/integrations/outbox/{job.id}/retry", headers=auth_headers).json()["status"] == "done"
        assert client.post(f"/api/v1/integrations/outbox/{uuid.uuid4()}/retry", headers=auth_headers).status_code == 404

    async def test_non_retryable_error_fails_immediately(self, client, auth_headers, db, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        from app.services.inventory import deduct_stock
        deduct_stock(db, item, 1, "sale", "transaction", "nr", idempotency_key="nr")
        db.commit()
        db.query(EbayToken).delete()  # seller disconnected: 409, keep retrying
        db.commit()
        await outbox.process_outbox(db)
        job = self._jobs(db, item)[0]
        assert job.status == "pending" and "Connect your eBay" in job.last_error
        fake.on("POST", "/bulk_update_price_quantity", (200, {"responses": []}))

    async def test_fans_out_to_stockx_and_ebay(self, client, auth_headers, db, token, item, fake):
        from app.models.stockx import StockxListing
        from app.services.inventory import deduct_stock
        self._listed(client, auth_headers, item, fake)
        item.size = None
        db.add(StockxListing(user_id=item.user_id, inventory_item_id=item.id, product_id="p", variant_id="v",
                             listing_id="lst", amount=Decimal("200"), currency_code="USD", status="active"))
        db.flush()
        deduct_stock(db, item, 3, "sale", "transaction", "fan", idempotency_key="fan")
        providers = sorted(j.provider for j in db.query(ProviderOutbox).filter_by(user_id=item.user_id).all())
        assert providers == ["ebay", "stockx"]

    def test_backoff_growth(self):
        assert outbox.backoff_for(1) == timedelta(seconds=30)
        assert outbox.backoff_for(3) == timedelta(seconds=120)
        assert outbox.backoff_for(50) == timedelta(seconds=3600)

    def test_unlisted_item_enqueues_nothing(self, db, item):
        from app.services.inventory import deduct_stock
        deduct_stock(db, item, 1, "sale", "transaction", "c", idempotency_key="c")
        assert not self._jobs(db, item)

    def test_manual_quantity_edit_enqueues(self, client, auth_headers, db, token, item, fake):
        self._listed(client, auth_headers, item, fake)
        r = client.put(f"/api/v1/inventory/{item.id}", json={"quantity": 1}, headers=auth_headers)
        assert r.status_code == 200, r.text
        assert len(self._jobs(db, item)) == 1


class TestEbayOrderStock:
    def _order(self, sku, order_id="O-1", line="L-1", qty=1, **extra):
        return {
            "orderId": order_id, "creationDate": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
            "pricingSummary": {"total": {"value": "250.00"}},
            "lineItems": [{"lineItemId": line, "sku": sku, "quantity": qty}], **extra,
        }

    def _linked(self, db, item, listed=True):
        link = InventoryExternalLink(inventory_item_id=item.id, user_id=item.user_id, provider="ebay",
                                     external_id=str(item.id), external_sku=str(item.id))
        if listed:
            link.offer_id, link.listing_status, link.listed_quantity = "OF", "active", 1
        db.add(link)
        db.flush()
        return link

    def test_order_deducts_exactly_once(self, db, test_user, item):
        link = self._linked(db, item)
        order = self._order(str(item.id))
        assert ebay_service._apply_order_stock(db, test_user.id, order) == 1
        assert ebay_service._apply_order_stock(db, test_user.id, order) == 0
        db.refresh(item)
        assert item.quantity == 2
        assert db.query(InventoryStockLedger).filter_by(idempotency_key="ebay:order:O-1:L-1").count() == 1
        assert link.listing_status == "sold"
        # eBay-sourced sale never echoes back to eBay
        assert not db.query(ProviderOutbox).filter_by(inventory_item_id=item.id).all()

    def test_cancelled_and_pre_link_orders_skipped(self, db, test_user, item):
        self._linked(db, item)
        cancelled = self._order(str(item.id), cancelStatus={"cancelState": "CANCELED"})
        old = self._order(str(item.id), order_id="O-2")
        old["creationDate"] = "2020-01-01T00:00:00.000Z"
        assert ebay_service._apply_order_stock(db, test_user.id, cancelled) == 0
        assert ebay_service._apply_order_stock(db, test_user.id, old) == 0

    def test_oversell_records_issue(self, db, test_user, item):
        self._linked(db, item)
        item.quantity = 0
        db.flush()
        assert ebay_service._apply_order_stock(db, test_user.id, self._order(str(item.id))) == 0
        db.flush()
        issue = db.query(ReconciliationIssue).filter_by(inventory_item_id=item.id).one()
        assert issue.issue_type == "stock_drift" and issue.details["reason"] == "oversold"

    def test_inventory_pull_does_not_overwrite_listed_item(self, db, test_user, item):
        self._linked(db, item)
        eb = {"sku": str(item.id), "product": {"title": "eBay title"},
              "availability": {"shipToLocationAvailability": {"quantity": 1}}}
        got, created = ebay_service._upsert_inventory_item(db, test_user.id, eb, Decimal("9"))
        assert got.id == item.id and not created
        assert item.quantity == 3 and item.name.startswith("Jordan")

    async def test_full_sync_with_order(self, db, test_user, token, item, fake):
        self._linked(db, item, listed=False)
        fake.on("GET", "/sell/fulfillment/v1/order", (200, {"orders": [self._order(str(item.id))], "total": 1}))
        fake.on("GET", "/sell/inventory/v1/inventory_item", (200, {"inventoryItems": [], "total": 0}))
        await ebay_service.sync(db, test_user.id)
        await ebay_service.sync(db, test_user.id)
        db.refresh(item)
        assert item.quantity == 2


class TestComps:
    @pytest.fixture(autouse=True)
    def _pro(self, test_user, db):
        test_user.subscription_tier = "pro"
        db.flush()

    async def test_active_asks_labelled_honestly(self, client, auth_headers, item, fake):
        fake.on("POST", "/identity/v1/oauth2/token", (200, {"access_token": "app", "expires_in": 7200}))
        fake.on("GET", "/buy/browse/v1/item_summary/search", (200, {"itemSummaries": [
            {"title": "a", "price": {"value": "200.00", "currency": "USD"}, "itemWebUrl": "u1"},
            {"title": "b", "price": {"value": "300.00", "currency": "USD"}},
            {"title": "c", "price": {"value": "250.00", "currency": "USD"}},
            {"title": "eur", "price": {"value": "1.00", "currency": "EUR"}},
        ]}))
        r = client.get(f"/api/v1/inventory/{item.id}/ebay-comps", headers=auth_headers)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["kind"] == "active_asks" and "not sold" in d["label"]
        assert d["summary"] == {"low": "200.00", "median": "250.00", "high": "300.00"} and d["count"] == 3
        search = [c for c in fake.calls if "item_summary" in c.url.path][0]
        assert search.headers["Authorization"] == "Bearer app"
        assert "new balance" not in search.url.params["q"].lower()
        assert "conditions:{NEW}" in search.url.params["filter"]

    async def test_insights_falls_back_when_not_granted(self, client, auth_headers, fake, monkeypatch):
        monkeypatch.setattr(ebay_listing.settings, "EBAY_MARKETPLACE_INSIGHTS", True)
        fake.on("POST", "/identity/v1/oauth2/token", (200, {"access_token": "app", "expires_in": 7200}))
        fake.on("GET", "/marketplace_insights/", (403, {}))
        fake.on("GET", "/buy/browse/v1/item_summary/search", (200, {"itemSummaries": []}))
        d = client.get("/api/v1/integrations/ebay/comps?q=jordan 1", headers=auth_headers).json()
        assert d["kind"] == "active_asks" and d["summary"] is None

    async def test_sold_when_insights_granted(self, client, auth_headers, fake, monkeypatch):
        monkeypatch.setattr(ebay_listing.settings, "EBAY_MARKETPLACE_INSIGHTS", True)
        fake.on("POST", "/identity/v1/oauth2/token", (200, {"access_token": "app", "expires_in": 7200}))
        fake.on("GET", "/marketplace_insights/", (200, {"itemSales": [
            {"title": "s", "lastSoldPrice": {"value": "210", "currency": "USD"}, "lastSoldDate": "2026-10-01"}]}))
        d = client.get("/api/v1/integrations/ebay/comps?q=jordan", headers=auth_headers).json()
        assert d["kind"] == "sold" and d["items"][0]["sold_date"] == "2026-10-01"

    def test_not_configured(self, client, auth_headers, fake, monkeypatch):
        monkeypatch.setattr(ebay_service, "client_id", "")
        r = client.get("/api/v1/integrations/ebay/comps?q=jordan", headers=auth_headers)
        assert r.status_code == 503

    def test_app_token_failure(self, client, auth_headers, fake):
        fake.on("POST", "/identity/v1/oauth2/token", (401, {}))
        r = client.get("/api/v1/integrations/ebay/comps?q=jordan", headers=auth_headers)
        assert r.status_code == 409


class TestImagesAndStatus:
    def test_signed_image(self, client, item):
        sig = ebay_listing.image_signature(item.id, "front")
        r = client.get(f"/api/v1/integrations/ebay/images/{item.id}/front/{sig}.jpg")
        assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
        assert client.get(f"/api/v1/integrations/ebay/images/{item.id}/front/{'0' * 32}.jpg").status_code == 404
        assert client.get(f"/api/v1/integrations/ebay/images/{uuid.uuid4()}/front/{sig}.jpg").status_code == 404

    def test_status_can_list(self, client, auth_headers, token):
        d = client.get("/api/v1/integrations/ebay/status", headers=auth_headers).json()
        assert d["connected"] and d["can_list"] and d["environment"] == "sandbox"

    def test_condition_mapping(self):
        assert ebay_listing.map_condition("used") == "USED_EXCELLENT"
        assert ebay_listing.map_condition("VNDS") == "NEW_OTHER"
        assert ebay_listing.map_condition("NEW_OTHER") == "NEW_OTHER"
        assert ebay_listing.map_condition(None) == "NEW"
