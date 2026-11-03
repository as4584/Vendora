"""StockX integration tests. Every StockX call goes to an httpx.MockTransport;
no real credentials are ever used."""
import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi import HTTPException

from app.config import settings
from app.models.inventory import InventoryExternalLink, InventoryItem, InventoryStockLedger
from app.models.provider import ReconciliationIssue
from app.models.provider_outbox import ProviderOutbox
from app.models.stockx import StockxListing, StockxMarketCache, StockxToken
from app.models.transaction import Transaction
from app.security.token_encryption import decrypt_token, encrypt_token
from app.services import stockx as sx
from app.services.inventory import deduct_stock
from app.services.stockx import stockx_service

PRODUCT = "prod-chicago"
V10 = "var-10"
V11 = "var-11"

PRODUCTS = [
    {"productId": "prod-other", "title": "Air Jordan 1 Retro High OG Bred", "styleId": "555088-001", "brand": "Jordan"},
    {
        "productId": PRODUCT,
        "title": "Air Jordan 1 Retro High OG Chicago Lost and Found",
        "styleId": "DZ5485-612",
        "brand": "Jordan",
        "productAttributes": {"colorway": "Varsity Red/Black"},
    },
]
VARIANTS = [
    {"variantId": V10, "variantValue": "10", "productId": PRODUCT},
    {"variantId": V11, "sizeChart": {"defaultConversion": {"size": "11", "type": "us m"}}, "productId": PRODUCT},
]


class FakeStockX:
    """Routes (METHOD, path) to queued responses; records every request."""

    def __init__(self):
        self.routes: dict[tuple[str, str], list] = {}
        self.calls: list[httpx.Request] = []

    def on(self, method, path, *responses):
        self.routes.setdefault((method, path), []).extend(responses)
        return self

    def count(self, method, path):
        return sum(1 for r in self.calls if r.method == method and _path(r) == path)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        key = (request.method, _path(request))
        queue = self.routes.get(key)
        if not queue:
            return httpx.Response(404, json={"errorMessage": f"no route {key}"})
        resp = queue.pop(0) if len(queue) > 1 else queue[0]
        if callable(resp):
            resp = resp(request)
        if isinstance(resp, httpx.Response):
            return resp
        code, body = resp
        return httpx.Response(code, json=body)


def _path(request: httpx.Request) -> str:
    url = request.url
    if url.host == "accounts.stockx.com":
        return url.path
    return url.path.removeprefix("/v2")


@pytest.fixture()
def configured(monkeypatch):
    monkeypatch.setattr(settings, "STOCKX_API_KEY", "test-api-key")
    monkeypatch.setattr(settings, "STOCKX_CLIENT_ID", "test-client")
    monkeypatch.setattr(settings, "STOCKX_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(settings, "STOCKX_REDIRECT_URI", "https://example.test/api/v1/integrations/stockx/callback")


@pytest.fixture()
def fake(monkeypatch, configured):
    fake = FakeStockX()
    monkeypatch.setattr(stockx_service, "transport", httpx.MockTransport(fake.handler))
    sleeps: list[float] = []

    async def no_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(stockx_service, "sleep", no_sleep)
    fake.sleeps = sleeps
    return fake


@pytest.fixture()
def token(db, test_user, configured):
    tok = StockxToken(
        user_id=test_user.id,
        access_token=encrypt_token("access-1"),
        refresh_token=encrypt_token("refresh-1"),
        expires_at=datetime.now(timezone.utc) + timedelta(hours=6),
    )
    db.add(tok)
    db.flush()
    return tok


def _item(db, user, **kw):
    defaults = dict(name="AJ1 Chicago Lost and Found", sku="DZ5485-612", size="10", quantity=1, buy_price=Decimal("150.00"))
    defaults.update(kw)
    item = InventoryItem(user_id=user.id, **defaults)
    db.add(item)
    db.flush()
    return item


def _link(db, item, variant_id=V10, size="10"):
    link = InventoryExternalLink(
        inventory_item_id=item.id, user_id=item.user_id, provider="stockx",
        external_id=f"{variant_id}:{item.id}", external_parent_id=PRODUCT,
        external_sku=variant_id, variant_label=size,
    )
    db.add(link)
    db.flush()
    return link


def _listing(db, item, status="active", listing_id="lst-1", size="10", variant_id=V10):
    listing = StockxListing(
        user_id=item.user_id, inventory_item_id=item.id, product_id=PRODUCT, variant_id=variant_id,
        size=size, listing_id=listing_id, amount=Decimal("250.00"), status=status,
    )
    db.add(listing)
    db.flush()
    return listing


# ── pure helpers ─────────────────────────────────────────────────────────────

class TestHelpers:
    @pytest.mark.parametrize("raw,expected", [("10", "10"), ("US M 10.5", "10.5"), ("Size 9", "9"), ("10.0", "10"), ("OS", "os")])
    def test_normalize_size(self, raw, expected):
        assert sx.normalize_size(raw) == expected

    def test_find_variant_by_value_and_size_chart(self):
        assert sx.find_variant(VARIANTS, "10")["variantId"] == V10
        assert sx.find_variant(VARIANTS, "US 11")["variantId"] == V11
        assert sx.find_variant(VARIANTS, "12") is None
        assert sx.find_variant([VARIANTS[0]], None)["variantId"] == V10
        assert sx.find_variant(VARIANTS, None) is None
        assert sx.find_variant([], "10") is None

    def test_parse_market_never_reads_asks_as_sales(self):
        fields = sx.parse_market({"lowestAskAmount": "260", "highestBidAmount": "230", "sellFasterAmount": "255"})
        assert fields == {"lowest_ask": Decimal("260.00"), "highest_bid": Decimal("230.00"), "last_sale": None}
        assert sx.parse_market({"lastSaleAmount": "241.5"})["last_sale"] == Decimal("241.50")

    def test_money(self):
        assert sx.money(None) is None
        assert sx.money("abc") is None
        assert sx.money(12) == Decimal("12.00")

    def test_item_sizes_and_remaining(self, db, test_user):
        item = _item(db, test_user, quantity=3, custom_attributes={"variants": [{"size": "10", "quantity": 1}, {"size": "11", "quantity": 2}]})
        assert sx.item_sizes(item) == [("10", 1), ("11", 2)]
        assert sx.remaining_for_size(item, "11") == 2
        plain = _item(db, test_user, quantity=2)
        assert sx.item_sizes(plain) == [("10", 2)]
        assert sx.remaining_for_size(plain, "10") == 2
        plain.status = "sold"
        assert sx.remaining_for_size(plain, "10") == 0


# ── configuration / OAuth ────────────────────────────────────────────────────

class TestNotConfigured:
    def test_status_reports_not_configured(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(settings, "STOCKX_API_KEY", "")
        resp = client.get("/api/v1/integrations/stockx/status", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["configured"] is False
        assert resp.json()["connected"] is False

    def test_connect_returns_503(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(settings, "STOCKX_CLIENT_ID", "")
        resp = client.get("/api/v1/integrations/stockx/connect", headers=auth_headers)
        assert resp.status_code == 503
        assert resp.json()["detail"] == "StockX not configured"

    def test_not_connected_is_409(self, client, auth_headers, db, test_user, configured):
        item = _item(db, test_user)
        resp = client.get(f"/api/v1/integrations/stockx/items/{item.id}/match", headers=auth_headers)
        assert resp.status_code == 409
        assert resp.json()["detail"] == "StockX not connected"
        assert client.post("/api/v1/integrations/stockx/sync", headers=auth_headers).status_code == 409


class TestOAuth:
    def test_authorization_url(self, client, auth_headers, configured):
        resp = client.get("/api/v1/integrations/stockx/connect", headers=auth_headers)
        url = urlparse(resp.json()["authorization_url"])
        qs = parse_qs(url.query)
        assert url.hostname == "accounts.stockx.com" and url.path == "/authorize"
        assert qs["audience"] == ["gateway.stockx.com"]
        assert qs["response_type"] == ["code"]
        assert "offline_access" in qs["scope"][0]
        assert qs["redirect_uri"] == [settings.STOCKX_REDIRECT_URI]

    def test_state_round_trip_and_rejections(self):
        uid = uuid.uuid4()
        assert stockx_service.parse_state(stockx_service.build_state(uid)) == uid
        from app.services.ebay import ebay_service

        with pytest.raises(HTTPException):
            stockx_service.parse_state(ebay_service.build_state(uid))
        with pytest.raises(HTTPException):
            stockx_service.parse_state("garbage")

    def test_callback_stores_encrypted_tokens(self, client, db, test_user, fake):
        fake.on("POST", "/oauth/token", (200, {"access_token": "acc", "refresh_token": "ref", "expires_in": 3600, "scope": "offline_access"}))
        state = stockx_service.build_state(test_user.id)
        resp = client.get(f"/api/v1/integrations/stockx/callback?code=abc&state={state}", follow_redirects=False)
        assert resp.status_code == 303
        assert resp.headers["location"].endswith("status=connected")
        body = parse_qs(fake.calls[0].content.decode())
        assert body["grant_type"] == ["authorization_code"] and body["code"] == ["abc"]
        tok = db.query(StockxToken).filter_by(user_id=test_user.id).one()
        assert tok.access_token.startswith("enc:")
        assert decrypt_token(tok.access_token) == "acc"

    def test_callback_denied(self, client, test_user, configured):
        state = stockx_service.build_state(test_user.id)
        resp = client.get(f"/api/v1/integrations/stockx/callback?error=access_denied&state={state}", follow_redirects=False)
        assert resp.headers["location"].endswith("status=denied")

    def test_callback_exchange_failure(self, client, test_user, fake):
        fake.on("POST", "/oauth/token", (400, {"error": "invalid_grant"}))
        state = stockx_service.build_state(test_user.id)
        resp = client.get(f"/api/v1/integrations/stockx/callback?code=bad&state={state}", follow_redirects=False)
        assert resp.status_code == 502

    def test_status_and_disconnect(self, client, auth_headers, db, test_user, token):
        _link(db, _item(db, test_user))
        status_body = client.get("/api/v1/integrations/stockx/status", headers=auth_headers).json()
        assert status_body["connected"] is True and status_body["matched_items"] == 1
        resp = client.delete("/api/v1/integrations/stockx", headers=auth_headers)
        assert resp.json() == {"disconnected": True, "links_retained": 1}
        assert db.query(StockxToken).filter_by(user_id=test_user.id).count() == 0


# ── HTTP: headers, refresh, 429 ──────────────────────────────────────────────

class TestRequest:
    async def test_sends_bearer_and_api_key(self, db, test_user, token, fake):
        fake.on("GET", "/catalog/search", (200, {"products": PRODUCTS}))
        await stockx_service.search(db, test_user.id, "jordan")
        req = fake.calls[0]
        assert req.headers["authorization"] == "Bearer access-1"
        assert req.headers["x-api-key"] == "test-api-key"
        assert req.url.params["query"] == "jordan"

    async def test_refreshes_near_expiry(self, db, test_user, token, fake):
        token.expires_at = datetime.now(timezone.utc) + timedelta(minutes=1)
        fake.on("POST", "/oauth/token", (200, {"access_token": "access-2", "expires_in": 43200}))
        fake.on("GET", "/catalog/search", (200, {"products": []}))
        await stockx_service.search(db, test_user.id, "x")
        body = parse_qs(fake.calls[0].content.decode())
        assert body["grant_type"] == ["refresh_token"] and body["refresh_token"] == ["refresh-1"]
        assert fake.calls[1].headers["authorization"] == "Bearer access-2"
        assert decrypt_token(token.refresh_token) == "refresh-1"  # kept when not rotated

    async def test_refreshes_once_on_401(self, db, test_user, token, fake):
        fake.on("POST", "/oauth/token", (200, {"access_token": "access-2", "refresh_token": "refresh-2", "expires_in": 43200}))
        fake.on("GET", "/catalog/search", (401, {}), (200, {"products": []}))
        await stockx_service.search(db, test_user.id, "x")
        assert decrypt_token(token.refresh_token) == "refresh-2"
        assert fake.count("GET", "/catalog/search") == 2

    async def test_refresh_failure_asks_to_reconnect(self, db, test_user, token, fake):
        token.expires_at = datetime.now(timezone.utc)
        fake.on("POST", "/oauth/token", (400, {"error": "invalid_grant"}))
        with pytest.raises(HTTPException) as exc:
            await stockx_service.search(db, test_user.id, "x")
        assert exc.value.status_code == 401

    async def test_429_backs_off_with_retry_after_then_succeeds(self, db, test_user, token, fake):
        fake.on(
            "GET", "/catalog/search",
            httpx.Response(429, headers={"Retry-After": "3"}),
            (429, {}),
            (200, {"products": PRODUCTS}),
        )
        products = await stockx_service.search(db, test_user.id, "x")
        assert len(products) == 2
        assert fake.sleeps == [3.0, 2.0]

    async def test_429_gives_up_after_max_retries(self, db, test_user, token, fake):
        fake.on("GET", "/catalog/search", (429, {"errorMessage": "slow down"}))
        with pytest.raises(sx.StockxAPIError) as exc:
            await stockx_service.search(db, test_user.id, "x")
        assert exc.value.status_code == 429
        assert fake.count("GET", "/catalog/search") == sx.MAX_429_RETRIES + 1
        assert fake.sleeps == [1.0, 2.0, 4.0]

    def test_429_surfaces_as_429_from_endpoint(self, client, auth_headers, db, test_user, token, fake):
        fake.on("GET", "/catalog/search", (429, {}))
        item = _item(db, test_user)
        resp = client.get(f"/api/v1/integrations/stockx/items/{item.id}/match", headers=auth_headers)
        assert resp.status_code == 429


# ── matching ─────────────────────────────────────────────────────────────────

class TestMatch:
    def test_match_prefers_style_code_and_returns_shortlist(self, client, auth_headers, db, test_user, token, fake):
        fake.on("GET", "/catalog/search", (200, {"products": PRODUCTS}))
        item = _item(db, test_user)
        body = client.get(f"/api/v1/integrations/stockx/items/{item.id}/match", headers=auth_headers).json()
        assert body["best"]["product_id"] == PRODUCT
        assert body["best"]["colorway"] == "Varsity Red/Black"
        assert {c["product_id"] for c in body["shortlist"]} == {PRODUCT, "prod-other"}

    def test_name_ranking_without_sku(self, client, auth_headers, db, test_user, token, fake):
        fake.on("GET", "/catalog/search", (200, {"products": PRODUCTS}))
        item = _item(db, test_user, sku=None, name="Jordan 1 Chicago Lost Found")
        body = client.get(f"/api/v1/integrations/stockx/items/{item.id}/match", headers=auth_headers).json()
        assert body["shortlist"][0]["product_id"] == PRODUCT

    def test_sku_search_falls_back_to_name(self, client, auth_headers, db, test_user, token, fake):
        fake.on("GET", "/catalog/search", (200, {"products": []}), (200, {"products": PRODUCTS}))
        item = _item(db, test_user)
        body = client.get(f"/api/v1/integrations/stockx/items/{item.id}/match", headers=auth_headers).json()
        assert fake.count("GET", "/catalog/search") == 2
        assert body["best"]["product_id"] == PRODUCT

    def test_confirm_maps_each_size_to_its_variant(self, client, auth_headers, db, test_user, token, fake):
        fake.on("GET", f"/catalog/products/{PRODUCT}/variants", (200, VARIANTS))
        item = _item(db, test_user, quantity=3, custom_attributes={"variants": [{"size": "10", "quantity": 1}, {"size": "11", "quantity": 2}, {"size": "14", "quantity": 0}]})
        resp = client.post(f"/api/v1/integrations/stockx/items/{item.id}/match", headers=auth_headers, json={"product_id": PRODUCT})
        assert resp.status_code == 200
        links = {link["size"]: link["variant_id"] for link in resp.json()["links"]}
        assert links == {"10": V10, "11": V11}
        # re-confirm replaces, never duplicates; manual override wins
        resp = client.post(
            f"/api/v1/integrations/stockx/items/{item.id}/match", headers=auth_headers,
            json={"product_id": PRODUCT, "sizes": {"10": V11, "11": V10}},
        )
        links = {link["size"]: link["variant_id"] for link in resp.json()["links"]}
        assert links == {"10": V11, "11": V10}
        assert db.query(InventoryExternalLink).filter_by(inventory_item_id=item.id).count() == 2

    def test_variants_endpoint(self, client, auth_headers, token, fake):
        fake.on("GET", f"/catalog/products/{PRODUCT}/variants", (200, {"variants": VARIANTS}))
        resp = client.get(f"/api/v1/integrations/stockx/variants?product_id={PRODUCT}", headers=auth_headers)
        assert resp.json() == [{"variant_id": V10, "size": "10"}, {"variant_id": V11, "size": "11"}]

    def test_other_users_item_is_404(self, client, second_auth_headers, db, test_user):
        item = _item(db, test_user)
        resp = client.get(f"/api/v1/integrations/stockx/items/{item.id}", headers=second_auth_headers)
        assert resp.status_code == 404


# ── market data ──────────────────────────────────────────────────────────────

MARKET_PATH = f"/catalog/products/{PRODUCT}/variants/{V10}/market-data"


class TestMarketData:
    def test_fetch_then_cache(self, client, auth_headers, db, test_user, token, fake):
        fake.on("GET", MARKET_PATH, (200, {"lowestAskAmount": "260", "highestBidAmount": "231", "currencyCode": "USD"}))
        item = _item(db, test_user)
        _link(db, item)
        first = client.get(f"/api/v1/integrations/stockx/items/{item.id}/market", headers=auth_headers).json()
        assert first[0]["lowest_ask"] == "260.00"
        assert first[0]["highest_bid"] == "231.00"
        assert first[0]["last_sale"] is None
        assert first[0]["size"] == "10"
        client.get(f"/api/v1/integrations/stockx/items/{item.id}/market", headers=auth_headers)
        assert fake.count("GET", MARKET_PATH) == 1  # second read served from cache

    async def test_expired_cache_refetches_and_stale_fallback(self, db, test_user, token, fake):
        old = datetime.now(timezone.utc) - timedelta(hours=1)
        db.add(StockxMarketCache(product_id=PRODUCT, variant_id=V10, currency_code="USD", lowest_ask=Decimal("200"), fetched_at=old))
        db.flush()
        fake.on("GET", MARKET_PATH, (500, {"errorMessage": "down"}))
        data = await stockx_service.market_data(db, test_user.id, PRODUCT, V10)
        assert data["stale"] is True and data["lowest_ask"] == Decimal("200.00")
        fake.routes[("GET", MARKET_PATH)] = [(200, {"lowestAskAmount": "210", "lastSaleAmount": "205"})]
        data = await stockx_service.market_data(db, test_user.id, PRODUCT, V10)
        assert data["stale"] is False and data["last_sale"] == Decimal("205.00")

    async def test_failure_without_cache_is_502(self, db, test_user, token, fake):
        fake.on("GET", MARKET_PATH, (500, {}))
        with pytest.raises(HTTPException) as exc:
            await stockx_service.market_data(db, test_user.id, PRODUCT, V10)
        assert exc.value.status_code == 502


# ── asks ─────────────────────────────────────────────────────────────────────

class TestListings:
    def test_create_update_delete(self, client, auth_headers, db, test_user, token, fake):
        fake.on("POST", "/selling/listings", (200, {"listingId": "lst-9", "operationStatus": "PENDING"}))
        fake.on("PATCH", "/selling/listings/lst-9", (200, {"listingId": "lst-9"}))
        fake.on("DELETE", "/selling/listings/lst-9", (200, {"listingId": "lst-9"}))
        item = _item(db, test_user)
        _link(db, item)
        resp = client.post(f"/api/v1/integrations/stockx/items/{item.id}/listings", headers=auth_headers, json={"variant_id": V10, "amount": "275.00"})
        assert resp.status_code == 201, resp.text
        listing = resp.json()
        assert listing["listing_id"] == "lst-9" and listing["status"] == "active"
        sent = json.loads(fake.calls[-1].content)
        assert sent == {"amount": "275.00", "variantId": V10, "currencyCode": "USD", "active": True}
        resp = client.patch(f"/api/v1/integrations/stockx/listings/{listing['id']}", headers=auth_headers, json={"amount": "265.00"})
        assert resp.json()["amount"] == "265.00"
        resp = client.delete(f"/api/v1/integrations/stockx/listings/{listing['id']}", headers=auth_headers)
        assert resp.json()["status"] == "deleted"

    def test_create_twice_updates_existing_ask(self, client, auth_headers, db, test_user, token, fake):
        fake.on("PATCH", "/selling/listings/lst-1", (200, {}))
        item = _item(db, test_user)
        _link(db, item)
        existing = _listing(db, item)
        resp = client.post(f"/api/v1/integrations/stockx/items/{item.id}/listings", headers=auth_headers, json={"variant_id": V10, "amount": "240.00"})
        assert resp.json()["id"] == str(existing.id)
        assert fake.count("POST", "/selling/listings") == 0

    def test_requires_match_and_stock(self, client, auth_headers, db, test_user, token, fake):
        item = _item(db, test_user)
        resp = client.post(f"/api/v1/integrations/stockx/items/{item.id}/listings", headers=auth_headers, json={"variant_id": V10, "amount": "240.00"})
        assert resp.status_code == 400
        _link(db, item)
        item.quantity = 0
        db.flush()
        resp = client.post(f"/api/v1/integrations/stockx/items/{item.id}/listings", headers=auth_headers, json={"variant_id": V10, "amount": "240.00"})
        assert resp.status_code == 409

    def test_rejected_ask_is_recorded(self, client, auth_headers, db, test_user, token, fake):
        fake.on("POST", "/selling/listings", (400, {"errorMessage": "amount below minimum"}))
        item = _item(db, test_user)
        _link(db, item)
        resp = client.post(f"/api/v1/integrations/stockx/items/{item.id}/listings", headers=auth_headers, json={"variant_id": V10, "amount": "1.00"})
        assert resp.status_code == 502
        assert "amount below minimum" in resp.json()["detail"]
        row = db.query(StockxListing).filter_by(inventory_item_id=item.id).one()
        assert row.status == "failed" and row.last_error == "amount below minimum"

    def test_update_unconfirmed_and_update_error(self, client, auth_headers, db, test_user, token, fake):
        item = _item(db, test_user)
        pending = _listing(db, item, status="pending", listing_id=None)
        resp = client.patch(f"/api/v1/integrations/stockx/listings/{pending.id}", headers=auth_headers, json={"amount": "200.00"})
        assert resp.status_code == 409
        active = _listing(db, item, listing_id="lst-2")
        fake.on("PATCH", "/selling/listings/lst-2", (422, {"message": "bad"}))
        resp = client.patch(f"/api/v1/integrations/stockx/listings/{active.id}", headers=auth_headers, json={"amount": "200.00"})
        assert resp.status_code == 502

    def test_delete_404_is_idempotent_and_500_errors(self, client, auth_headers, db, test_user, token, fake):
        item = _item(db, test_user)
        gone = _listing(db, item, listing_id="lst-gone")
        fake.on("DELETE", "/selling/listings/lst-gone", (404, {}))
        assert client.delete(f"/api/v1/integrations/stockx/listings/{gone.id}", headers=auth_headers).json()["status"] == "deleted"
        broken = _listing(db, item, listing_id="lst-err")
        fake.on("DELETE", "/selling/listings/lst-err", (500, {}))
        assert client.delete(f"/api/v1/integrations/stockx/listings/{broken.id}", headers=auth_headers).status_code == 502

    def test_missing_listing_404(self, client, auth_headers):
        assert client.delete(f"/api/v1/integrations/stockx/listings/{uuid.uuid4()}", headers=auth_headers).status_code == 404


# ── sell-out -> outbox ───────────────────────────────────────────────────────

def _sell(db, item, qty=1, key=None):
    return deduct_stock(db, item, qty, "sale", "transaction", "t", idempotency_key=key or f"k-{uuid.uuid4()}")


class TestSelloutOutbox:
    def test_sellout_writes_job_in_same_transaction(self, db, test_user):
        item = _item(db, test_user, quantity=1)
        listing = _listing(db, item)
        _sell(db, item)
        job = db.query(ProviderOutbox).one()
        assert job.provider == "stockx" and job.action == "delete_listing"
        assert job.payload == {"stockx_listing_id": str(listing.id)}
        assert db.info.get("provider_outbox_pending") is True

    def test_rollback_drops_job(self, db, test_user):
        item = _item(db, test_user, quantity=1)
        _listing(db, item)
        db.commit()
        _sell(db, item)
        db.rollback()
        assert db.query(ProviderOutbox).count() == 0

    def test_no_job_while_stock_remains(self, db, test_user):
        item = _item(db, test_user, quantity=2)
        _listing(db, item)
        _sell(db, item)
        assert db.query(ProviderOutbox).count() == 0

    def test_per_size_sellout(self, db, test_user):
        item = _item(db, test_user, quantity=3, custom_attributes={"variants": [{"size": "10", "quantity": 0}, {"size": "11", "quantity": 2}]})
        ask10 = _listing(db, item, listing_id="a10", size="10")
        _listing(db, item, listing_id="a11", size="11", variant_id=V11)
        _sell(db, item)
        jobs = db.query(ProviderOutbox).all()
        assert [j.payload["stockx_listing_id"] for j in jobs] == [str(ask10.id)]

    def test_enqueue_is_idempotent(self, db, test_user):
        item = _item(db, test_user, quantity=1)
        _listing(db, item)
        _sell(db, item)
        assert sx.enqueue_sellout_delists(db, item) == 0
        assert db.query(ProviderOutbox).count() == 1

    async def test_process_deletes_ask(self, db, test_user, token, fake):
        fake.on("DELETE", "/selling/listings/lst-1", (200, {}))
        item = _item(db, test_user, quantity=1)
        listing = _listing(db, item)
        _sell(db, item)
        db.commit()
        assert await sx.process_outbox(db) == 1
        job = db.query(ProviderOutbox).one()
        assert job.status == "done" and job.attempts == 1
        assert listing.status == "deleted"
        assert await sx.process_outbox(db) == 0  # done jobs never rerun
        assert fake.count("DELETE", "/selling/listings/lst-1") == 1

    async def test_failure_backs_off_then_fails_then_manual_retry(self, client, auth_headers, db, test_user, token, fake):
        fake.on("DELETE", "/selling/listings/lst-1", (500, {"errorMessage": "boom"}))
        item = _item(db, test_user, quantity=1)
        _listing(db, item)
        _sell(db, item)
        db.commit()
        job = db.query(ProviderOutbox).one()
        job.max_attempts = 2
        db.commit()
        now = datetime.now(timezone.utc)
        await sx.process_outbox(db, now=now)
        assert job.status == "pending" and job.last_error == "boom"
        assert job.next_attempt_at >= now + sx.OUTBOX_BACKOFF_BASE
        assert await sx.process_outbox(db, now=now) == 0  # not due yet
        await sx.process_outbox(db, now=now + timedelta(hours=1))
        assert job.status == "failed"

        errors = client.get("/api/v1/integrations/stockx/outbox", headers=auth_headers).json()
        assert errors[0]["last_error"] == "boom"
        assert client.get("/api/v1/integrations/stockx/status", headers=auth_headers).json()["outbox_errors"] == 1

        fake.routes[("DELETE", "/selling/listings/lst-1")] = [(200, {})]
        resp = client.post(f"/api/v1/integrations/stockx/outbox/{job.id}/retry", headers=auth_headers)
        assert resp.json()["status"] == "done"
        assert client.post(f"/api/v1/integrations/stockx/outbox/{job.id}/retry", headers=auth_headers).json()["status"] == "done"
        assert client.post(f"/api/v1/integrations/stockx/outbox/{uuid.uuid4()}/retry", headers=auth_headers).status_code == 404

    async def test_not_connected_job_records_error(self, db, test_user, configured):
        item = _item(db, test_user, quantity=1)
        _listing(db, item)
        _sell(db, item)
        db.commit()
        await sx.process_outbox(db)
        job = db.query(ProviderOutbox).one()
        assert job.status == "pending" and job.last_error == "StockX not connected"

    async def test_pending_listing_without_id_is_closed_locally(self, db, test_user, configured):
        item = _item(db, test_user, quantity=1)
        listing = _listing(db, item, status="pending", listing_id=None)
        _sell(db, item)
        db.commit()
        # no token needed: nothing to delete remotely
        await sx.process_outbox(db)
        assert db.query(ProviderOutbox).one().status == "done"
        assert listing.status == "deleted"

    def test_checkout_sale_enqueues(self, client, auth_headers, db, test_user):
        item = _item(db, test_user, quantity=1)
        _listing(db, item)
        db.commit()
        resp = client.post(
            "/api/v1/transactions", headers=auth_headers,
            json={"item_id": str(item.id), "method": "cash", "gross_amount": "200.00", "fee_amount": "0.00"},
        )
        assert resp.status_code in (200, 201), resp.text
        assert db.query(ProviderOutbox).count() == 1


# ── orders ───────────────────────────────────────────────────────────────────

def _order(number="ord-1", listing_id="lst-1", status="AUTHORIZED", amount="250", payout="225.50"):
    return {
        "orderNumber": number, "listingId": listing_id, "amount": amount, "status": status,
        "variant": {"variantId": V10}, "payout": {"totalPayout": payout},
    }


class TestOrders:
    def _routes(self, fake, active, history=()):
        fake.on("GET", "/selling/orders/active", (200, {"orders": list(active), "hasNextPage": False}))
        fake.on("GET", "/selling/orders/history", (200, {"orders": list(history), "hasNextPage": False}))

    def test_imports_sale_exactly_once(self, client, auth_headers, db, test_user, token, fake):
        self._routes(fake, [_order()], [_order(), _order("ord-x", status="CANCELED")])
        item = _item(db, test_user, quantity=1)
        listing = _listing(db, item)
        resp = client.post("/api/v1/integrations/stockx/sync", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["transactions_imported"] == 1
        txn = db.query(Transaction).filter_by(source="stockx").one()
        assert txn.gross_amount == Decimal("250.00")
        assert txn.fee_amount == Decimal("24.50")
        assert txn.net_amount == Decimal("225.50")
        assert txn.cost_amount == Decimal("150.00")  # before_insert listener
        assert txn.variant_size == "10"
        db.refresh(item)
        assert item.quantity == 0 and item.status == "sold"
        assert listing.status == "sold"
        assert db.query(ProviderOutbox).count() == 0  # sold ask is not deleted

        again = client.post("/api/v1/integrations/stockx/sync", headers=auth_headers).json()
        assert again["transactions_imported"] == 0 and again["transactions_existing"] == 1
        assert db.query(Transaction).filter_by(source="stockx").count() == 1
        assert db.query(InventoryStockLedger).filter_by(inventory_item_id=item.id).count() == 1

    def test_paginates(self, db, test_user, token, fake, client, auth_headers):
        fake.on(
            "GET", "/selling/orders/active",
            (200, {"orders": [_order("o1", listing_id="")], "hasNextPage": True}),
            (200, {"orders": [_order("o2", listing_id="")], "hasNextPage": False}),
        )
        fake.on("GET", "/selling/orders/history", (200, {"orders": []}))
        item = _item(db, test_user, quantity=2)
        _link(db, item)
        body = client.post("/api/v1/integrations/stockx/sync", headers=auth_headers).json()
        assert body["transactions_imported"] == 2
        assert fake.count("GET", "/selling/orders/active") == 2

    def test_variant_link_fallback_and_size_deduction(self, db, test_user, token):
        item = _item(db, test_user, quantity=2, custom_attributes={"variants": [{"size": "10", "quantity": 1}, {"size": "11", "quantity": 1}]})
        _link(db, item)
        assert stockx_service.import_order(db, test_user.id, _order(listing_id="unknown")) == "imported"
        db.refresh(item)
        assert item.quantity == 1
        assert item.custom_attributes["variants"][0]["quantity"] == 0

    def test_unmatched_order_records_issue(self, db, test_user, token):
        order = _order(listing_id="", amount="100")
        order["variant"] = {"variantId": "nope"}
        assert stockx_service.import_order(db, test_user.id, order) == "skipped"
        db.flush()
        assert db.query(ReconciliationIssue).filter_by(provider="stockx", external_id="ord-1").count() == 1
        assert stockx_service.import_order(db, test_user.id, {"status": "AUTHORIZED"}) == "skipped"

    def test_sale_without_local_stock_keeps_sale_flags_drift(self, db, test_user, token):
        item = _item(db, test_user, quantity=0)
        _listing(db, item)
        assert stockx_service.import_order(db, test_user.id, _order()) == "imported"
        db.flush()
        assert db.query(ReconciliationIssue).filter_by(provider="stockx", issue_type="stock_drift").count() == 1

    def test_sync_api_error(self, client, auth_headers, token, fake):
        fake.on("GET", "/selling/orders/active", (500, {}))
        assert client.post("/api/v1/integrations/stockx/sync", headers=auth_headers).status_code == 502


def test_item_summary(client, auth_headers, db, test_user):
    item = _item(db, test_user)
    _link(db, item)
    _listing(db, item)
    body = client.get(f"/api/v1/integrations/stockx/items/{item.id}", headers=auth_headers).json()
    assert body["links"] == [{"product_id": PRODUCT, "variant_id": V10, "size": "10"}]
    assert body["listings"][0]["amount"] == "250.00"
