"""StockX asks created without a listingId get re-checked instead of staying
"pending" forever. All HTTP goes to the FakeStockX MockTransport."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.services.stockx import stockx_service
from tests import test_stockx_integration as base
from tests.test_stockx_integration import PRODUCT, V10, V11, _item, _link, _listing

# Reuse the StockX fixtures (MockTransport, settings, encrypted token).
configured = base.configured
fake = base.fake
token = base.token


def _remote(listing_id, variant=V10, amount="250.00", status="ACTIVE"):
    return {"listingId": listing_id, "status": status, "amount": amount,
            "variant": {"variantId": variant}, "product": {"productId": PRODUCT}}


class TestRecheckPending:
    async def test_finds_the_ask_by_variant_and_amount(self, db, test_user, token, fake):
        item = _item(db, test_user)
        pending = _listing(db, item, status="pending", listing_id=None)
        _listing(db, item, status="active", listing_id="lst-taken")
        fake.on("GET", "/selling/listings", (200, {"listings": [
            _remote("lst-taken"),
            _remote("lst-other-price", amount="999.00"),
            _remote("lst-other-size", variant=V11),
            _remote("lst-new"),
        ]}))
        changed = await stockx_service.recheck_pending_listings(db, test_user.id)
        assert changed == 1
        db.refresh(pending)
        assert pending.listing_id == "lst-new"
        assert pending.status == "active"
        req = fake.calls[0]
        assert req.url.params["variantIds"] == V10

    async def test_remote_status_is_mapped(self, db, test_user, token, fake):
        item = _item(db, test_user)
        pending = _listing(db, item, status="pending", listing_id=None)
        fake.on("GET", "/selling/listings", (200, {"listings": [_remote("lst-s", status="MATCHED")]}))
        await stockx_service.recheck_pending_listings(db, test_user.id)
        db.refresh(pending)
        assert (pending.listing_id, pending.status) == ("lst-s", "sold")

    async def test_still_pending_on_stockx_keeps_id_then_reads_it_directly(self, db, test_user, token, fake):
        item = _item(db, test_user)
        pending = _listing(db, item, status="pending", listing_id=None)
        fake.on("GET", "/selling/listings", (200, {"listings": [_remote("lst-p", status="PENDING")]}))
        await stockx_service.recheck_pending_listings(db, test_user.id)
        db.refresh(pending)
        assert (pending.listing_id, pending.status) == ("lst-p", "pending")

        fake.on("GET", "/selling/listings/lst-p", (200, _remote("lst-p", status="ACTIVE")))
        await stockx_service.recheck_pending_listings(db, test_user.id)
        db.refresh(pending)
        assert pending.status == "active"
        assert fake.count("GET", "/selling/listings/lst-p") == 1

    async def test_gone_listing_is_deleted(self, db, test_user, token, fake):
        item = _item(db, test_user)
        pending = _listing(db, item, status="pending", listing_id="lst-gone")
        fake.on("GET", "/selling/listings/lst-gone", (404, {}))
        await stockx_service.recheck_pending_listings(db, test_user.id)
        db.refresh(pending)
        assert pending.status == "deleted"

    async def test_not_found_yet_stays_pending_then_fails_after_give_up(self, db, test_user, token, fake):
        item = _item(db, test_user)
        pending = _listing(db, item, status="pending", listing_id=None)
        fake.on("GET", "/selling/listings", (200, {"listings": []}))
        assert await stockx_service.recheck_pending_listings(db, test_user.id) == 0
        db.refresh(pending)
        assert pending.status == "pending"

        later = datetime.now(timezone.utc) + timedelta(days=2)
        await stockx_service.recheck_pending_listings(db, test_user.id, now=later)
        db.refresh(pending)
        assert pending.status == "failed"
        assert "never confirmed" in pending.last_error

    async def test_api_error_is_recorded_not_raised(self, db, test_user, token, fake):
        item = _item(db, test_user)
        pending = _listing(db, item, status="pending", listing_id=None)
        fake.on("GET", "/selling/listings", (500, {"errorMessage": "boom"}))
        await stockx_service.recheck_pending_listings(db, test_user.id)
        db.refresh(pending)
        assert pending.status == "pending"
        assert pending.last_error

    async def test_nothing_pending_makes_no_calls(self, db, test_user, token, fake):
        item = _item(db, test_user)
        _listing(db, item, status="active")
        assert await stockx_service.recheck_pending_listings(db, test_user.id) == 0
        assert fake.calls == []


class TestRecheckEntryPoints:
    def test_viewing_the_item_rechecks(self, client, auth_headers, db, test_user, token, fake):
        item = _item(db, test_user)
        _link(db, item)
        _listing(db, item, status="pending", listing_id=None)
        db.commit()
        fake.on("GET", "/selling/listings", (200, {"listings": [_remote("lst-view")]}))
        body = client.get(f"/api/v1/integrations/stockx/items/{item.id}", headers=auth_headers).json()
        assert body["listings"][0]["listing_id"] == "lst-view"
        assert body["listings"][0]["status"] == "active"

    def test_sync_rechecks(self, client, auth_headers, db, test_user, token, fake):
        fake.on("GET", "/selling/orders/active", (200, {"orders": [], "hasNextPage": False}))
        fake.on("GET", "/selling/orders/history", (200, {"orders": [], "hasNextPage": False}))
        fake.on("GET", "/selling/listings", (200, {"listings": [_remote("lst-sync", amount="250")]}))
        item = _item(db, test_user)
        pending = _listing(db, item, status="pending", listing_id=None)
        db.commit()
        resp = client.post("/api/v1/integrations/stockx/sync", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        db.refresh(pending)
        assert (pending.listing_id, pending.status) == ("lst-sync", "active")
        assert pending.amount == Decimal("250.00")
