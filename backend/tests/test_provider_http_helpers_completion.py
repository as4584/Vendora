"""Provider HTTP/OAuth edge tests with deterministic in-memory clients."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.integration import LightspeedToken
from app.models.provider import ProviderSyncRun
from app.models.inventory import InventoryItem
from app.models.transaction import Transaction
from app.security.token_encryption import decrypt_token, encrypt_token
from app.services import lightspeed as lightspeed_module
from app.services import square as square_module
from app.services import clover as clover_module
from app.services.lightspeed import LightspeedService
from app.services.square import SquareService
from app.services.clover import CloverService


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


class FakeAsyncClient:
    responses = []
    calls = []

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, **kwargs):
        type(self).calls.append(("get", url, kwargs))
        return type(self).responses.pop(0)

    async def post(self, url, **kwargs):
        type(self).calls.append(("post", url, kwargs))
        return type(self).responses.pop(0)


@pytest.fixture(autouse=True)
def reset_fake_client():
    FakeAsyncClient.responses = []
    FakeAsyncClient.calls = []


def configured_lightspeed():
    service = LightspeedService()
    service.client_id = "client"
    service.client_secret = "secret"
    service.redirect_uri = "vendora://callback"
    return service


def test_lightspeed_configuration_and_authorization_url():
    service = LightspeedService()
    service.client_id = ""
    service.client_secret = ""
    service.redirect_uri = ""
    with pytest.raises(HTTPException) as exc:
        service.authorization_url("state")
    assert exc.value.status_code == 503

    service = configured_lightspeed()
    url = service.authorization_url("signed state", scope="inventory:all")
    assert "client_id=client" in url
    assert "scope=inventory%3Aall" in url
    assert "state=signed+state" in url


def test_lightspeed_state_rejects_wrong_purpose(monkeypatch):
    monkeypatch.setattr(lightspeed_module.jwt, "decode", lambda *args, **kwargs: {"purpose": "wrong", "sub": str(uuid.uuid4())})
    with pytest.raises(HTTPException) as exc:
        configured_lightspeed().parse_state("state")
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_lightspeed_code_exchange_success_and_failure(monkeypatch):
    monkeypatch.setattr(lightspeed_module.httpx, "AsyncClient", FakeAsyncClient)
    service = configured_lightspeed()
    FakeAsyncClient.responses = [FakeResponse(payload={"access_token": "a", "expires_in": 60})]
    payload = await service.exchange_authorization_code("code")
    assert payload["access_token"] == "a"
    assert payload["expires_at"] > datetime.now(timezone.utc)
    assert FakeAsyncClient.calls[0][2]["data"]["grant_type"] == "authorization_code"

    FakeAsyncClient.responses = [FakeResponse(401, text="bad")]
    with pytest.raises(HTTPException) as exc:
        await service.exchange_authorization_code("bad")
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_lightspeed_refresh_and_expiry_paths(monkeypatch):
    monkeypatch.setattr(lightspeed_module.httpx, "AsyncClient", FakeAsyncClient)
    service = configured_lightspeed()
    token = SimpleNamespace(
        user_id=uuid.uuid4(),
        access_token=encrypt_token("old"),
        refresh_token=encrypt_token("refresh"),
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=30),
    )
    db = SimpleNamespace(commit=lambda: None, refresh=lambda value: None)
    FakeAsyncClient.responses = [FakeResponse(payload={"access_token": "new", "refresh_token": "new-refresh", "expires_in": 3600})]
    refreshed = await service._ensure_valid_token(db, token)
    assert decrypt_token(refreshed.access_token) == "new"
    assert decrypt_token(refreshed.refresh_token) == "new-refresh"

    previous_refresh = refreshed.refresh_token
    FakeAsyncClient.responses = [FakeResponse(payload={"access_token": "newer", "expires_in": 3600})]
    await service._refresh_access_token(db, refreshed)
    assert refreshed.refresh_token == previous_refresh

    valid = SimpleNamespace(expires_at=datetime.now(timezone.utc) + timedelta(hours=1))
    assert await service._ensure_valid_token(db, valid) is valid

    FakeAsyncClient.responses = [FakeResponse(400)]
    token.expires_at = datetime.now(timezone.utc)
    with pytest.raises(HTTPException) as exc:
        await service._refresh_access_token(db, token)
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_lightspeed_pagination_handles_dict_rate_limit_and_error(monkeypatch):
    monkeypatch.setattr(lightspeed_module.httpx, "AsyncClient", FakeAsyncClient)
    sleeps = []

    async def no_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(lightspeed_module.asyncio, "sleep", no_sleep)
    FakeAsyncClient.responses = [
        FakeResponse(429),
        FakeResponse(payload={"Item": {"itemID": "1"}, "@attributes": {"count": 2}}),
        FakeResponse(payload={"Item": [{"itemID": "2"}], "@attributes": {"count": 2}}),
    ]
    result = await configured_lightspeed()._get_all_pages("token", "https://api/items", "Item")
    assert [item["itemID"] for item in result] == ["1", "2"]
    assert sleeps == [60, lightspeed_module._RATE_LIMIT_SLEEP]

    FakeAsyncClient.responses = [FakeResponse(500, text="down")]
    assert await configured_lightspeed()._get_all_pages("token", "https://api/items", "Item") == []


def test_lightspeed_token_upsert_and_transaction_update(db, test_user):
    service = configured_lightspeed()
    expires = datetime.now(timezone.utc) + timedelta(hours=1)
    token = service.upsert_token(
        db, user_id=test_user.id, account_id="one", access_token="a", refresh_token="r", expires_at=expires
    )
    updated = service.upsert_token(
        db, user_id=test_user.id, account_id="two", access_token="b", refresh_token="r2", expires_at=expires, scopes="all"
    )
    assert updated.id == token.id
    assert updated.account_id == "two"
    assert decrypt_token(updated.access_token) == "b"
    assert service.is_connected(db, test_user.id)
    assert service.get_connection_id(db, test_user.id) == "two"
    assert service.get_connection_id(db, uuid.uuid4()) is None
    assert service._safe_decimal("bad") == 0

    txn, created = service._upsert_transaction(db, test_user.id, {"saleID": "s1", "total": "12", "totalTax": "2"})
    db.flush()
    assert created and txn.net_amount == 10
    same, created = service._upsert_transaction(db, test_user.id, {"saleID": "s1", "total": "20", "totalTax": "3"})
    assert not created and same.gross_amount == 20 and same.net_amount == 17


@pytest.mark.asyncio
async def test_lightspeed_sync_requires_token(db, test_user):
    run = ProviderSyncRun(provider="lightspeed", user_id=test_user.id, status="running")
    db.add(run)
    db.flush()
    with pytest.raises(HTTPException) as exc:
        await configured_lightspeed()._do_sync(db, test_user.id, run)
    assert exc.value.status_code == 404


def test_lightspeed_item_accepts_single_price_and_fallback_price(db, test_user):
    service = configured_lightspeed()
    single = {
        "itemID": "single-price", "description": "Single", "qoh": 1,
        "Prices": {"ItemPrice": {"useType": "Sale", "amount": "7.50"}},
        "Category": "not-a-dict", "defaultCost": "bad",
    }
    item, created = service._upsert_inventory_item(db, test_user.id, single)
    assert created and item.expected_sell_price == Decimal("7.50")
    assert item.category is None and item.buy_price == Decimal("0.00")


@pytest.mark.asyncio
async def test_lightspeed_full_sync_counts_all_outcomes(monkeypatch, db, test_user):
    service = configured_lightspeed()
    token = LightspeedToken(
        user_id=test_user.id,
        account_id="acct",
        access_token=encrypt_token("access"),
        refresh_token=encrypt_token("refresh"),
        expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    db.add(token)
    run = ProviderSyncRun(provider="lightspeed", user_id=test_user.id, status="running")
    db.add(run)
    db.flush()
    pages = [
        [{"itemID": "new"}, {"itemID": "updated"}, {"itemID": "stale", "description": "gone"}],
        [{"saleID": "new"}, {"saleID": "updated"}],
    ]

    async def get_pages(*args):
        return pages.pop(0)

    monkeypatch.setattr(service, "_get_all_pages", get_pages)
    outcomes = iter([(SimpleNamespace(id=uuid.uuid4()), True), (SimpleNamespace(id=uuid.uuid4()), False), (None, False)])
    monkeypatch.setattr(service, "_upsert_inventory_item", lambda *args: next(outcomes))
    sale_outcomes = iter([(SimpleNamespace(id=uuid.uuid4()), True), (SimpleNamespace(id=uuid.uuid4()), False)])
    monkeypatch.setattr(service, "_upsert_transaction", lambda *args: next(sale_outcomes))
    result = await service._do_sync(db, test_user.id, run)
    assert (result.items_imported, result.items_updated, result.items_skipped, result.errors_count) == (1, 1, 1, 1)
    assert (result.transactions_imported, result.transactions_updated) == (1, 1)


@pytest.mark.asyncio
async def test_square_catalog_pagination_and_error(monkeypatch):
    monkeypatch.setattr(square_module.httpx, "AsyncClient", FakeAsyncClient)
    service = SquareService()
    FakeAsyncClient.responses = [
        FakeResponse(payload={"objects": [{"id": "1"}], "cursor": "next"}),
        FakeResponse(payload={"objects": [{"id": "2"}]}),
    ]
    assert await service._fetch_catalog("token") == [{"id": "1"}, {"id": "2"}]
    assert FakeAsyncClient.calls[1][2]["params"]["cursor"] == "next"
    FakeAsyncClient.responses = [FakeResponse(500, text="down")]
    assert await service._fetch_catalog("token") == []


@pytest.mark.asyncio
async def test_clover_item_pagination_and_error(monkeypatch):
    monkeypatch.setattr(clover_module.httpx, "AsyncClient", FakeAsyncClient)
    service = CloverService()
    full_page = [{"id": str(index)} for index in range(clover_module._PAGE_SIZE)]
    FakeAsyncClient.responses = [
        FakeResponse(payload={"elements": full_page}),
        FakeResponse(payload={"elements": [{"id": "last"}]}),
    ]
    items = await service._fetch_items("token", "merchant")
    assert len(items) == clover_module._PAGE_SIZE + 1
    assert FakeAsyncClient.calls[1][2]["params"]["offset"] == clover_module._PAGE_SIZE
    assert service._auth_headers("token")["Authorization"] == "Bearer token"

    FakeAsyncClient.responses = [FakeResponse(500, text="down")]
    assert await service._fetch_items("token", "merchant") == []


def test_clover_helper_edge_values():
    service = CloverService()
    assert service._safe_price("bad") is None
    assert service._extract_qty({}) == 0
    assert service._extract_qty({"itemStock": {"quantity": "bad"}}) == 0
    assert service._extract_qty({"itemStock": {"quantity": "4.9"}}) == 4
    assert service._extract_category({}) is None
    assert service._extract_category({"categories": {"elements": []}}) is None
    assert service._extract_category({"categories": {"elements": [{"name": "Shoes"}]}}) == "Shoes"


def test_provider_updates_preserve_sku_and_category_when_payload_omits_them(db, test_user):
    run = SimpleNamespace(id=uuid.uuid4())
    clover = CloverService()
    created, _ = clover._upsert_item(
        db,
        test_user.id,
        {
            "id": "clover-optional",
            "name": "Original",
            "sku": "KEEP-SKU",
            "price": 100,
            "itemStock": {"quantity": 1},
            "categories": {"elements": [{"name": "Keep Category"}]},
        },
        run,
    )
    db.flush()
    updated, was_created = clover._upsert_item(
        db,
        test_user.id,
        {"id": "clover-optional", "name": "Updated", "price": 200, "itemStock": {"quantity": 1}},
        run,
    )
    assert was_created is False
    assert updated.sku == "KEEP-SKU" and updated.category == "Keep Category"

    square = SquareService()
    variation = {
        "id": "square-optional",
        "item_variation_data": {"name": "Regular", "sku": "SQ-KEEP", "price_money": {"amount": 100}},
    }
    sq_item, _ = square._upsert_item(db, test_user.id, variation, 1, "Square Item", run)
    db.flush()
    no_sku = {"id": "square-optional", "item_variation_data": {"name": "Regular", "price_money": {"amount": 200}}}
    updated_sq, was_created = square._upsert_item(db, test_user.id, no_sku, 1, "Square Updated", run)
    assert was_created is False
    assert updated_sq.sku == "SQ-KEEP"


@pytest.mark.asyncio
async def test_square_inventory_counts_filters_sums_and_handles_errors(monkeypatch):
    monkeypatch.setattr(square_module.httpx, "AsyncClient", FakeAsyncClient)
    service = SquareService()
    assert await service._fetch_inventory_counts("token", [], None) == {}
    FakeAsyncClient.responses = [
        FakeResponse(payload={"counts": [
            {"state": "SOLD", "catalog_object_id": "a", "quantity": "9"},
            {"state": "IN_STOCK", "catalog_object_id": "", "quantity": "1"},
            {"state": "IN_STOCK", "catalog_object_id": "a", "quantity": "2.9"},
            {"state": "IN_STOCK", "catalog_object_id": "b", "quantity": "bad"},
        ], "cursor": "next"}),
        FakeResponse(payload={"counts": [{"state": "IN_STOCK", "catalog_object_id": "a", "quantity": "3"}]}),
    ]
    result = await service._fetch_inventory_counts("token", ["a", "b"], "loc")
    assert result == {"a": 5, "b": 0}
    assert FakeAsyncClient.calls[0][2]["json"]["location_ids"] == ["loc"]
    FakeAsyncClient.responses = [FakeResponse(500, text="down")]
    assert await service._fetch_inventory_counts("token", ["a"], None) == {}


@pytest.mark.asyncio
async def test_square_payment_pagination_and_error(monkeypatch):
    monkeypatch.setattr(square_module.httpx, "AsyncClient", FakeAsyncClient)
    FakeAsyncClient.responses = [
        FakeResponse(payload={"payments": [{"id": "p1"}], "cursor": "next"}),
        FakeResponse(payload={"payments": None}),
    ]
    payments = await SquareService._fetch_payments(
        "token", "loc", datetime(2026, 1, 1, tzinfo=timezone.utc)
    )
    assert payments == [{"id": "p1"}]
    assert FakeAsyncClient.calls[0][2]["params"]["location_id"] == "loc"
    assert FakeAsyncClient.calls[1][2]["params"]["cursor"] == "next"
    FakeAsyncClient.responses = [FakeResponse(500, text="down")]
    assert await SquareService._fetch_payments("token") == []


def test_square_credential_headers_price_and_bad_payment_date(db, test_user):
    service = SquareService()
    assert service._auth_headers("x")["Authorization"] == "Bearer x"
    assert service._safe_price("bad") is None
    cred = service.store_credential(db, user_id=test_user.id, access_token="one", merchant_id="m1")
    updated = service.store_credential(db, user_id=test_user.id, access_token="two", merchant_id="m2", location_id="l2")
    assert updated.id == cred.id and updated.merchant_id == "m2" and updated.location_id == "l2"
    assert decrypt_token(updated.access_token) == "two"

    run = SimpleNamespace(id=uuid.uuid4())
    txn, created = service._upsert_payment(db, test_user.id, {
        "id": "bad-date", "total_money": {"amount": 123}, "status": "MYSTERY", "created_at": object()
    }, run)
    db.flush()
    assert created and txn.status == "completed" and txn.gross_amount == Decimal("1.23")
    assert db.query(Transaction).filter_by(external_reference_id="bad-date").one()


@pytest.mark.asyncio
async def test_square_sync_tolerates_payment_row_and_fetch_failures(monkeypatch, db, test_user):
    service = SquareService()
    service.store_credential(db, user_id=test_user.id, access_token="token")
    run = ProviderSyncRun(provider="square", user_id=test_user.id, status="running")
    db.add(run)
    db.flush()

    async def empty_catalog(*args):
        return [{"type": "CATEGORY", "id": "ignored"}]

    async def empty_counts(*args):
        return {}

    async def payments(*args, **kwargs):
        return [{"id": "boom"}, {"id": "created"}, {"id": "updated"}, {}]

    monkeypatch.setattr(service, "_fetch_catalog", empty_catalog)
    monkeypatch.setattr(service, "_fetch_inventory_counts", empty_counts)
    monkeypatch.setattr(service, "_fetch_payments", payments)
    outcomes = iter([RuntimeError("bad row"), (SimpleNamespace(), True), (SimpleNamespace(), False), (None, False)])

    def upsert(*args):
        outcome = next(outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(service, "_upsert_payment", upsert)
    result = await service._do_sync(db, test_user.id, run)
    assert result.errors_count == 1
    assert result.transactions_imported == 1
    assert result.transactions_updated == 1

    async def failed_payments(*args, **kwargs):
        raise RuntimeError("payments offline")

    monkeypatch.setattr(service, "_fetch_payments", failed_payments)
    result = await service._do_sync(db, test_user.id, run)
    assert result.errors_count == 0
