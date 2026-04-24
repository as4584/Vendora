"""Clover provider adapter tests.

Coverage:
  Unit (service layer — no HTTP):
    TestCloverUpsertItem
      - new item creates InventoryItem + ExternalLink + import_adjust ledger entry
      - item with no id records import_error issue and returns (None, False)
      - item with empty name records import_error issue and returns (None, False)
      - price converted correctly from integer cents to Decimal dollars
      - item without itemStock gets quantity=0, no ledger entry written
      - re-sync with same quantity: item updated, NO new ledger entry
      - re-sync with changed quantity: item updated + 'sync' ledger entry written
      - stale link (soft-deleted item): records stale_link issue, returns (None, False)
      - import_adjust idempotency: second sync finds existing link, no duplicate item

    TestCloverSyncResult (mocking _fetch_items)
      - successful sync creates completed ProviderSyncRun with correct counters
      - partial sync (some items skip) marks run as partial
      - sync with empty catalog creates run with all-zero counters
      - unhandled per-item exception records import_error issue
      - sync without credentials raises RuntimeError
      - multiple items creates multiple InventoryItems with correct data
      - idempotent repeat sync does not duplicate items

  Route-level:
    TestCloverConnectEndpoint
      - POST /connect stores credentials (merchant_id + access_token)
      - GET /status returns connected=False when not connected
      - GET /status returns connected=True with merchant_id after connect
      - POST /connect updates existing credential (upsert)

    TestCloverSyncEndpoint
      - POST /sync 400 when not connected
      - POST /sync returns CloverSyncResponse with run_id on success
      - POST /sync result visible in GET /sync-runs?provider=clover
      - POST /sync reconciliation issues visible in GET /reconciliation-issues?provider=clover
      - POST /sync does not affect other provider runs
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest

from app.models.clover import CloverCredential
from app.models.inventory import (
    InventoryExternalLink,
    InventoryItem,
    InventoryStockLedger,
)
from app.models.provider import ProviderSyncRun, ReconciliationIssue
from app.security.token_encryption import decrypt_token
from app.services.clover import clover_service
from app.services.providers.base import SyncResult


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _make_credential(
    db,
    user_id: uuid.UUID,
    *,
    merchant_id: str = "MERCH_CLV",
    access_token: str = "clv_test_token",
) -> CloverCredential:
    cred = CloverCredential(
        user_id=user_id,
        merchant_id=merchant_id,
        access_token=access_token,
    )
    db.add(cred)
    db.flush()
    return cred


def _make_run(db, user_id: uuid.UUID) -> ProviderSyncRun:
    run = ProviderSyncRun(
        provider="clover",
        user_id=user_id,
        started_at=datetime.now(timezone.utc),
        status="running",
    )
    db.add(run)
    db.flush()
    return run


def _clover_item(
    item_id: str = "CLV_001",
    name: str = "Blue Shirt",
    price_cents: int = 2500,
    sku: str | None = "SKU-001",
    qty: float = 10.0,
    category: str | None = "Apparel",
    include_stock: bool = True,
) -> dict:
    """Build a minimal Clover item dict as returned by GET /v3/merchants/{mid}/items."""
    item: dict = {
        "id": item_id,
        "name": name,
        "price": price_cents,
    }
    if sku is not None:
        item["sku"] = sku
    if include_stock:
        item["itemStock"] = {"quantity": qty}
    if category is not None:
        item["categories"] = {"elements": [{"name": category}]}
    return item


# ─── TestCloverUpsertItem ─────────────────────────────────────────────────────

class TestCloverUpsertItem:
    def test_new_item_creates_item_link_and_ledger(self, db, test_user):
        run = _make_run(db, test_user.id)
        item_dict = _clover_item("CLV_NEW", "Blue Shirt", 2500, "SKU-001", 10.0, "Apparel")

        item, created = clover_service._upsert_item(db, test_user.id, item_dict, run)
        db.flush()

        assert created is True
        assert item is not None
        assert item.name == "Blue Shirt"
        assert item.sku == "SKU-001"
        assert item.expected_sell_price == Decimal("25.00")
        assert item.quantity == 10
        assert item.category == "Apparel"
        assert item.source == "clover"
        assert item.external_id == "CLV_NEW"

        link = db.query(InventoryExternalLink).filter(
            InventoryExternalLink.user_id == test_user.id,
            InventoryExternalLink.provider == "clover",
            InventoryExternalLink.external_id == "CLV_NEW",
        ).one()
        assert link.inventory_item_id == item.id
        assert link.last_synced_at is not None

        ledger = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
            InventoryStockLedger.event_type == "import_adjust",
        ).one()
        assert ledger.delta_quantity == 10
        assert ledger.quantity_after == 10
        assert ledger.source_type == "clover"
        assert ledger.idempotency_key == "clover:import:CLV_NEW"

    def test_missing_id_records_issue_and_returns_none(self, db, test_user):
        run = _make_run(db, test_user.id)
        bad_item = {"name": "No ID Item", "price": 1000}

        result_item, created = clover_service._upsert_item(db, test_user.id, bad_item, run)
        db.flush()

        assert result_item is None
        assert created is False

        issue = db.query(ReconciliationIssue).filter(
            ReconciliationIssue.user_id == test_user.id,
            ReconciliationIssue.issue_type == "import_error",
        ).first()
        assert issue is not None
        assert issue.provider == "clover"

    def test_empty_name_records_issue_and_returns_none(self, db, test_user):
        run = _make_run(db, test_user.id)
        bad_item = {"id": "CLV_NONAME", "name": "   ", "price": 1000}

        result_item, created = clover_service._upsert_item(db, test_user.id, bad_item, run)
        db.flush()

        assert result_item is None
        assert created is False

        issue = db.query(ReconciliationIssue).filter(
            ReconciliationIssue.user_id == test_user.id,
            ReconciliationIssue.issue_type == "import_error",
        ).first()
        assert issue is not None
        assert issue.external_id == "CLV_NONAME"

    def test_price_converted_from_cents(self, db, test_user):
        run = _make_run(db, test_user.id)
        item_dict = _clover_item("CLV_PRICE", price_cents=9999)

        item, _ = clover_service._upsert_item(db, test_user.id, item_dict, run)
        db.flush()

        assert item is not None
        assert item.expected_sell_price == Decimal("99.99")

    def test_item_without_stock_gets_zero_quantity_and_no_ledger(self, db, test_user):
        run = _make_run(db, test_user.id)
        item_dict = _clover_item("CLV_NOSTOCK", qty=0.0, include_stock=False)

        item, created = clover_service._upsert_item(db, test_user.id, item_dict, run)
        db.flush()

        assert created is True
        assert item is not None
        assert item.quantity == 0

        # No ledger entry because qty=0
        ledger_count = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
        ).count()
        assert ledger_count == 0

    def test_resync_same_quantity_no_new_ledger_entry(self, db, test_user):
        run = _make_run(db, test_user.id)
        item_dict = _clover_item("CLV_SAME", qty=5.0)

        item, created = clover_service._upsert_item(db, test_user.id, item_dict, run)
        db.flush()
        assert created is True

        run2 = _make_run(db, test_user.id)
        item2, created2 = clover_service._upsert_item(db, test_user.id, item_dict, run2)
        db.flush()

        assert created2 is False
        assert item2 is not None
        assert item2.id == item.id

        sync_entries = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
            InventoryStockLedger.event_type == "sync",
        ).all()
        assert len(sync_entries) == 0

    def test_resync_changed_quantity_writes_sync_ledger(self, db, test_user):
        run = _make_run(db, test_user.id)
        item_dict = _clover_item("CLV_CHANGE", qty=10.0)

        item, _ = clover_service._upsert_item(db, test_user.id, item_dict, run)
        db.flush()

        item_dict_updated = dict(item_dict, **{"itemStock": {"quantity": 7.0}})
        run2 = _make_run(db, test_user.id)
        item2, created2 = clover_service._upsert_item(db, test_user.id, item_dict_updated, run2)
        db.flush()

        assert created2 is False
        assert item2 is not None
        assert item2.quantity == 7

        ledger = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
            InventoryStockLedger.event_type == "sync",
        ).one()
        assert ledger.delta_quantity == -3
        assert ledger.quantity_after == 7
        assert ledger.source_type == "clover"

    def test_stale_link_records_issue_and_returns_none(self, db, test_user):
        run = _make_run(db, test_user.id)

        # Create a soft-deleted item with an external link
        item = InventoryItem(
            user_id=test_user.id,
            name="Deleted Cap",
            quantity=5,
            status="in_stock",
            source="clover",
            external_id="CLV_STALE",
            deleted_at=datetime.now(timezone.utc),
        )
        db.add(item)
        db.flush()
        db.add(
            InventoryExternalLink(
                inventory_item_id=item.id,
                user_id=test_user.id,
                provider="clover",
                external_id="CLV_STALE",
                last_synced_at=None,
            )
        )
        db.flush()

        item_dict = _clover_item("CLV_STALE")
        result_item, created = clover_service._upsert_item(db, test_user.id, item_dict, run)
        db.flush()

        assert result_item is None
        assert created is False

        issue = db.query(ReconciliationIssue).filter(
            ReconciliationIssue.user_id == test_user.id,
            ReconciliationIssue.issue_type == "stale_link",
        ).one()
        assert issue.external_id == "CLV_STALE"
        assert issue.status == "open"
        assert issue.provider == "clover"

    def test_import_adjust_idempotency_key_prevents_duplicate(self, db, test_user):
        """A repeat call with the same item_id finds the existing link and updates it."""
        run = _make_run(db, test_user.id)
        item_dict = _clover_item("CLV_IDEM", qty=3.0)

        item, created1 = clover_service._upsert_item(db, test_user.id, item_dict, run)
        db.flush()
        assert created1 is True

        run2 = _make_run(db, test_user.id)
        item2, created2 = clover_service._upsert_item(db, test_user.id, item_dict, run2)
        db.flush()

        assert created2 is False
        assert item2 is not None
        assert item2.id == item.id

        # Exactly one import_adjust entry
        count = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
            InventoryStockLedger.event_type == "import_adjust",
        ).count()
        assert count == 1


# ─── TestCloverSyncResult ─────────────────────────────────────────────────────

class TestCloverSyncResult:
    """Tests for _do_sync (full sync path) with mocked HTTP calls."""

    def _seed_cred(self, db, user_id):
        return _make_credential(db, user_id)

    @pytest.mark.asyncio
    async def test_successful_sync_creates_completed_run(self, db, test_user):
        self._seed_cred(db, test_user.id)
        items = [_clover_item("CLV_S1", "Hat", 1000, "HAT-01", 5.0, "Hats")]

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=items)):
            result = await clover_service.sync(db, test_user.id)

        assert isinstance(result, SyncResult)
        assert result.items_imported == 1
        assert result.items_updated == 0
        assert result.errors_count == 0

        run = db.query(ProviderSyncRun).filter(ProviderSyncRun.id == result.run_id).one()
        assert run.status == "completed"
        assert run.provider == "clover"
        assert run.items_imported == 1
        assert run.completed_at is not None

    @pytest.mark.asyncio
    async def test_partial_sync_when_some_items_skip(self, db, test_user):
        self._seed_cred(db, test_user.id)
        bad_item = {"name": "No ID", "price": 500}
        items = [_clover_item("CLV_PART1"), bad_item]

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=items)):
            result = await clover_service.sync(db, test_user.id)

        assert result.items_imported == 1
        assert result.items_skipped == 1
        assert result.errors_count == 1

        run = db.query(ProviderSyncRun).filter(ProviderSyncRun.id == result.run_id).one()
        assert run.status == "partial"

    @pytest.mark.asyncio
    async def test_sync_with_empty_catalog_creates_zero_counter_run(self, db, test_user):
        self._seed_cred(db, test_user.id)

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=[])):
            result = await clover_service.sync(db, test_user.id)

        assert result.items_imported == 0
        assert result.items_updated == 0
        assert result.errors_count == 0

        run = db.query(ProviderSyncRun).filter(ProviderSyncRun.id == result.run_id).one()
        assert run.status == "completed"

    @pytest.mark.asyncio
    async def test_unhandled_exception_records_import_error_issue(self, db, test_user):
        self._seed_cred(db, test_user.id)
        items = [_clover_item("CLV_BOOM")]

        def boom(db_, user_id_, clover_item, run):
            raise ValueError("Simulated crash")

        with (
            patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=items)),
            patch.object(clover_service, "_upsert_item", side_effect=boom),
        ):
            result = await clover_service.sync(db, test_user.id)

        assert result.errors_count == 1

        issue = db.query(ReconciliationIssue).filter(
            ReconciliationIssue.user_id == test_user.id,
            ReconciliationIssue.issue_type == "import_error",
            ReconciliationIssue.severity == "error",
        ).first()
        assert issue is not None
        assert "Simulated crash" in issue.details.get("error", "")

    @pytest.mark.asyncio
    async def test_sync_without_credentials_raises(self, db, test_user):
        """_do_sync without credentials should raise RuntimeError."""
        from app.services.providers.base import SyncRunManager

        run = SyncRunManager.start(db, "clover", test_user.id)
        with pytest.raises(RuntimeError, match="Clover credentials not found"):
            await clover_service._do_sync(db, test_user.id, run)

    @pytest.mark.asyncio
    async def test_multiple_items_creates_multiple_inventory_items(self, db, test_user):
        self._seed_cred(db, test_user.id)
        items = [
            _clover_item("CLV_A", "Red Mug", 800, "MUG-R", 3.0, "Mugs"),
            _clover_item("CLV_B", "Blue Mug", 900, "MUG-B", 7.0, "Mugs"),
            _clover_item("CLV_C", "Green Mug", 850, "MUG-G", 0.0, "Mugs"),
        ]

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=items)):
            result = await clover_service.sync(db, test_user.id)

        assert result.items_imported == 3
        assert result.errors_count == 0

        inv_items = (
            db.query(InventoryItem)
            .filter(
                InventoryItem.user_id == test_user.id,
                InventoryItem.source == "clover",
            )
            .all()
        )
        assert len(inv_items) == 3
        names = {i.name for i in inv_items}
        assert "Red Mug" in names
        assert "Blue Mug" in names
        assert "Green Mug" in names

    @pytest.mark.asyncio
    async def test_idempotent_repeat_sync_no_duplicate_items(self, db, test_user):
        """Running sync twice on the same catalog creates items only once."""
        self._seed_cred(db, test_user.id)
        items = [_clover_item("CLV_DUP", qty=4.0)]

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=items)):
            await clover_service.sync(db, test_user.id)

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=items)):
            result2 = await clover_service.sync(db, test_user.id)

        assert result2.items_imported == 0
        assert result2.items_updated == 1
        assert result2.errors_count == 0

        item_count = (
            db.query(InventoryItem)
            .filter(
                InventoryItem.user_id == test_user.id,
                InventoryItem.external_id == "CLV_DUP",
            )
            .count()
        )
        assert item_count == 1

    @pytest.mark.asyncio
    async def test_resync_updates_existing_item(self, db, test_user):
        self._seed_cred(db, test_user.id)
        items_first = [_clover_item("CLV_UPD", "Old Name", qty=5.0)]
        items_second = [_clover_item("CLV_UPD", "New Name", qty=3.0)]

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=items_first)):
            result1 = await clover_service.sync(db, test_user.id)
        assert result1.items_imported == 1

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=items_second)):
            result2 = await clover_service.sync(db, test_user.id)

        assert result2.items_imported == 0
        assert result2.items_updated == 1
        assert result2.errors_count == 0

        item = (
            db.query(InventoryItem)
            .filter(InventoryItem.external_id == "CLV_UPD", InventoryItem.user_id == test_user.id)
            .one()
        )
        assert item.name == "New Name"
        assert item.quantity == 3

        sync_ledger = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
            InventoryStockLedger.event_type == "sync",
        ).one()
        assert sync_ledger.delta_quantity == -2


# ─── TestCloverConnectEndpoint ────────────────────────────────────────────────

class TestCloverConnectEndpoint:
    def test_connect_stores_credentials(self, client, auth_headers, db, test_user):
        resp = client.post(
            "/api/v1/integrations/clover/connect",
            json={"merchant_id": "MERCH_CLV_123", "access_token": "clv_live_TOKEN"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["message"] == "Clover account connected."
        assert data["merchant_id"] == "MERCH_CLV_123"

        cred = db.query(CloverCredential).filter(
            CloverCredential.user_id == test_user.id
        ).one()
        assert decrypt_token(cred.access_token) == "clv_live_TOKEN"
        assert cred.merchant_id == "MERCH_CLV_123"

    def test_status_not_connected(self, client, auth_headers):
        resp = client.get("/api/v1/integrations/clover/status", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is False
        assert data["merchant_id"] is None
        assert data["last_synced_at"] is None

    def test_status_connected_after_connect(self, client, auth_headers, db, test_user):
        _make_credential(db, test_user.id, merchant_id="MERCH_CHECK")
        db.commit()

        resp = client.get("/api/v1/integrations/clover/status", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is True
        assert data["merchant_id"] == "MERCH_CHECK"

    def test_connect_updates_existing_credential(self, client, auth_headers, db, test_user):
        _make_credential(db, test_user.id, merchant_id="OLD_MID", access_token="old_tok")
        db.commit()

        resp = client.post(
            "/api/v1/integrations/clover/connect",
            json={"merchant_id": "NEW_MID", "access_token": "new_tok"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["merchant_id"] == "NEW_MID"

        cred = db.query(CloverCredential).filter(
            CloverCredential.user_id == test_user.id
        ).one()
        assert cred.merchant_id == "NEW_MID"
        assert decrypt_token(cred.access_token) == "new_tok"


# ─── TestCloverSyncEndpoint ───────────────────────────────────────────────────

class TestCloverSyncEndpoint:
    def _seed_cred(self, db, user_id):
        return _make_credential(db, user_id)

    def test_sync_400_when_not_connected(self, client, auth_headers):
        resp = client.post("/api/v1/integrations/clover/sync", headers=auth_headers)
        assert resp.status_code == 400
        assert "not connected" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_sync_returns_run_id_and_counters(
        self, client, auth_headers, db, test_user
    ):
        self._seed_cred(db, test_user.id)
        db.commit()

        items = [_clover_item("CLV_RT1", "Canvas Bag", 3200, "BAG-01", 2.0, "Bags")]

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=items)):
            resp = client.post("/api/v1/integrations/clover/sync", headers=auth_headers)

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert data["items_imported"] == 1
        assert data["errors_count"] == 0
        assert "run_id" in data

    @pytest.mark.asyncio
    async def test_sync_run_visible_in_list(self, client, auth_headers, db, test_user):
        self._seed_cred(db, test_user.id)
        db.commit()

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=[])):
            resp = client.post("/api/v1/integrations/clover/sync", headers=auth_headers)

        assert resp.status_code == 200

        runs_resp = client.get(
            "/api/v1/integrations/sync-runs?provider=clover", headers=auth_headers
        )
        assert runs_resp.status_code == 200
        runs = runs_resp.json()
        assert len(runs) >= 1
        assert all(r["provider"] == "clover" for r in runs)

    @pytest.mark.asyncio
    async def test_reconciliation_issues_visible_after_sync(
        self, client, auth_headers, db, test_user
    ):
        self._seed_cred(db, test_user.id)
        db.commit()

        # Bad item — no id — triggers import_error issue
        bad_item = {"name": "No ID", "price": 500}

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=[bad_item])):
            client.post("/api/v1/integrations/clover/sync", headers=auth_headers)

        issues_resp = client.get(
            "/api/v1/integrations/reconciliation-issues?provider=clover",
            headers=auth_headers,
        )
        assert issues_resp.status_code == 200
        issues = issues_resp.json()
        assert len(issues) >= 1
        assert all(i["provider"] == "clover" for i in issues)
        assert any(i["issue_type"] == "import_error" for i in issues)

    @pytest.mark.asyncio
    async def test_sync_does_not_affect_other_provider_runs(
        self, client, auth_headers, db, test_user
    ):
        """Clover sync creates only clover ProviderSyncRun rows."""
        self._seed_cred(db, test_user.id)
        db.commit()

        with patch.object(clover_service, "_fetch_items", new=AsyncMock(return_value=[])):
            client.post("/api/v1/integrations/clover/sync", headers=auth_headers)

        # No square sync runs should exist
        square_runs = client.get(
            "/api/v1/integrations/sync-runs?provider=square", headers=auth_headers
        )
        assert square_runs.status_code == 200
        assert len(square_runs.json()) == 0
