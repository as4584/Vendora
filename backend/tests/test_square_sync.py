"""Square provider adapter tests.

Coverage:
  Unit (service layer — no HTTP):
    TestSquareUpsertItem
      - new variation creates InventoryItem + ExternalLink + import_adjust ledger entry
      - variation with no ID records import_error issue and returns (None, False)
      - variation with "Regular" name uses parent name only
      - price converted correctly from cents to dollars
      - re-sync with same quantity: item updated, NO new ledger entry
      - re-sync with changed quantity: item updated + 'sync' ledger entry written
      - stale link (soft-deleted item): records stale_link issue, returns (None, False)
      - import_adjust ledger entry is idempotent (second sync does not duplicate)

    TestSquareSyncResult (mocking _fetch_catalog + _fetch_inventory_counts)
      - successful sync creates completed ProviderSyncRun with correct counters
      - partial sync (some variations skip) marks run as partial
      - sync with no variations creates run with all-zero counters
      - unhandled per-item exception records import_error issue

  Route-level:
    TestSquareConnectEndpoint
      - POST /connect stores credentials and returns message
      - POST /connect with location_id stores location_id
      - GET /status returns connected=False when not connected
      - GET /status returns connected=True with merchant_id after connect

    TestSquareSyncEndpoint
      - POST /sync 400 when not connected
      - POST /sync returns SquareSyncResponse with run_id on success
      - POST /sync result visible in GET /sync-runs?provider=square
      - POST /sync reconciliation issues visible in GET /reconciliation-issues?provider=square
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest

from app.models.inventory import (
    InventoryExternalLink,
    InventoryItem,
    InventoryStockLedger,
)
from app.models.provider import ProviderSyncRun, ReconciliationIssue
from app.models.square import SquareCredential
from app.security.token_encryption import decrypt_token
from app.services.providers.base import SyncResult
from app.services.square import square_service


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _make_credential(
    db,
    user_id: uuid.UUID,
    *,
    access_token: str = "sq_test_token",
    merchant_id: str = "MERCH_001",
    location_id: str | None = None,
) -> SquareCredential:
    cred = SquareCredential(
        user_id=user_id,
        access_token=access_token,
        merchant_id=merchant_id,
        location_id=location_id,
    )
    db.add(cred)
    db.flush()
    return cred


def _make_run(db, user_id: uuid.UUID) -> ProviderSyncRun:
    run = ProviderSyncRun(
        provider="square",
        user_id=user_id,
        started_at=datetime.now(timezone.utc),
        status="running",
    )
    db.add(run)
    db.flush()
    return run


def _variation(
    variation_id: str = "VAR_001",
    variation_name: str = "Blue / Medium",
    sku: str | None = "SKU-001",
    price_cents: int | None = 2500,
) -> dict:
    """Build a minimal Square ITEM_VARIATION dict."""
    var_data: dict = {"name": variation_name}
    if sku is not None:
        var_data["sku"] = sku
    if price_cents is not None:
        var_data["price_money"] = {"amount": price_cents, "currency": "USD"}
    return {"id": variation_id, "type": "ITEM_VARIATION", "item_variation_data": var_data}


def _catalog_item(
    item_id: str = "ITEM_001",
    name: str = "T-Shirt",
    variations: list[dict] | None = None,
) -> dict:
    """Build a minimal Square ITEM catalog object."""
    if variations is None:
        variations = [_variation()]
    return {
        "type": "ITEM",
        "id": item_id,
        "item_data": {"name": name, "variations": variations},
    }


def _count(variation_id: str = "VAR_001", qty: str = "10", state: str = "IN_STOCK") -> dict:
    return {"catalog_object_id": variation_id, "quantity": qty, "state": state}


# ─── TestSquareUpsertItem ──────────────────────────────────────────────────────

class TestSquareUpsertItem:
    def test_new_variation_creates_item_link_and_ledger(self, db, test_user):
        run = _make_run(db, test_user.id)
        var = _variation("VAR_NEW", "Medium", "SKU-M", 3000)

        item, created = square_service._upsert_item(
            db, test_user.id, var, qty=5, parent_name="Jacket", run=run
        )
        db.flush()

        assert created is True
        assert item is not None
        assert item.name == "Jacket - Medium"
        assert item.sku == "SKU-M"
        assert item.expected_sell_price == Decimal("30.00")
        assert item.quantity == 5
        assert item.source == "square"
        assert item.external_id == "VAR_NEW"

        link = db.query(InventoryExternalLink).filter(
            InventoryExternalLink.user_id == test_user.id,
            InventoryExternalLink.provider == "square",
            InventoryExternalLink.external_id == "VAR_NEW",
        ).one()
        assert link.inventory_item_id == item.id
        assert link.last_synced_at is not None

        ledger = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
            InventoryStockLedger.event_type == "import_adjust",
        ).one()
        assert ledger.delta_quantity == 5
        assert ledger.quantity_after == 5
        assert ledger.source_type == "square"
        assert ledger.idempotency_key == "square:import:VAR_NEW"

    def test_regular_variation_name_uses_parent_only(self, db, test_user):
        run = _make_run(db, test_user.id)
        var = _variation("VAR_REG", "Regular", "SKU-REG", 1000)

        item, created = square_service._upsert_item(
            db, test_user.id, var, qty=1, parent_name="Mug", run=run
        )
        db.flush()

        assert created is True
        assert item.name == "Mug"

    def test_missing_variation_id_records_issue_and_returns_none(self, db, test_user):
        run = _make_run(db, test_user.id)
        bad_var = {"type": "ITEM_VARIATION", "item_variation_data": {"name": "Size M"}}

        item, created = square_service._upsert_item(
            db, test_user.id, bad_var, qty=3, parent_name="Widget", run=run
        )
        db.flush()

        assert item is None
        assert created is False

        issue = db.query(ReconciliationIssue).filter(
            ReconciliationIssue.user_id == test_user.id,
            ReconciliationIssue.issue_type == "import_error",
        ).first()
        assert issue is not None
        assert issue.provider == "square"

    def test_price_converted_from_cents(self, db, test_user):
        run = _make_run(db, test_user.id)
        var = _variation("VAR_PRICE", price_cents=9999)

        item, _ = square_service._upsert_item(
            db, test_user.id, var, qty=1, parent_name="Watch", run=run
        )
        db.flush()

        assert item.expected_sell_price == Decimal("99.99")

    def test_zero_price_produces_none_price(self, db, test_user):
        """Variations with price_money=None should result in price=None."""
        run = _make_run(db, test_user.id)
        var = _variation("VAR_NOPRICE", price_cents=None)
        var["item_variation_data"].pop("price_money", None)  # ensure it's absent

        item, _ = square_service._upsert_item(
            db, test_user.id, var, qty=0, parent_name="Freebie", run=run
        )
        db.flush()

        assert item.expected_sell_price is None

    def test_resync_same_quantity_no_new_ledger_entry(self, db, test_user):
        run = _make_run(db, test_user.id)
        var = _variation("VAR_SAME", "Large")

        # First sync
        item, created = square_service._upsert_item(
            db, test_user.id, var, qty=4, parent_name="Hoodie", run=run
        )
        db.flush()
        assert created is True

        # Second sync — same quantity
        run2 = _make_run(db, test_user.id)
        item2, created2 = square_service._upsert_item(
            db, test_user.id, var, qty=4, parent_name="Hoodie", run=run2
        )
        db.flush()

        assert created2 is False
        assert item2.id == item.id

        sync_entries = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
            InventoryStockLedger.event_type == "sync",
        ).all()
        assert len(sync_entries) == 0  # no sync ledger written

    def test_resync_changed_quantity_writes_sync_ledger(self, db, test_user):
        run = _make_run(db, test_user.id)
        var = _variation("VAR_CHANGE", "XL")

        item, _ = square_service._upsert_item(
            db, test_user.id, var, qty=10, parent_name="Shirt", run=run
        )
        db.flush()

        run2 = _make_run(db, test_user.id)
        item2, created2 = square_service._upsert_item(
            db, test_user.id, var, qty=7, parent_name="Shirt", run=run2
        )
        db.flush()

        assert created2 is False
        assert item2.quantity == 7

        ledger = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
            InventoryStockLedger.event_type == "sync",
        ).one()
        assert ledger.delta_quantity == -3
        assert ledger.quantity_after == 7
        assert ledger.source_type == "square"

    def test_stale_link_records_issue_and_returns_none(self, db, test_user):
        """When a linked InventoryItem is soft-deleted, emit stale_link issue."""
        run = _make_run(db, test_user.id)

        # Create a soft-deleted item with an external link
        item = InventoryItem(
            user_id=test_user.id,
            name="Deleted Hat",
            quantity=5,
            status="in_stock",
            source="square",
            external_id="VAR_STALE",
            deleted_at=datetime.now(timezone.utc),
        )
        db.add(item)
        db.flush()
        db.add(
            InventoryExternalLink(
                inventory_item_id=item.id,
                user_id=test_user.id,
                provider="square",
                external_id="VAR_STALE",
                last_synced_at=None,
            )
        )
        db.flush()

        var = _variation("VAR_STALE")
        result_item, created = square_service._upsert_item(
            db, test_user.id, var, qty=5, parent_name="Hat", run=run
        )
        db.flush()

        assert result_item is None
        assert created is False

        issue = db.query(ReconciliationIssue).filter(
            ReconciliationIssue.user_id == test_user.id,
            ReconciliationIssue.issue_type == "stale_link",
        ).one()
        assert issue.external_id == "VAR_STALE"
        assert issue.status == "open"
        assert issue.provider == "square"

    def test_import_adjust_idempotency_key_prevents_duplicate(self, db, test_user):
        """A repeat call with the same variation after flush re-uses the same link
        (the UniqueConstraint on ExternalLink would fire if we tried to create twice).
        The import_adjust ledger entry uses an idempotency key so a second write
        would be caught by the DB unique index on idempotency_key.
        """
        run = _make_run(db, test_user.id)
        var = _variation("VAR_IDEM", "S")

        item, created1 = square_service._upsert_item(
            db, test_user.id, var, qty=3, parent_name="Cap", run=run
        )
        db.flush()
        assert created1 is True

        # Second call with same variation — should update, not create
        run2 = _make_run(db, test_user.id)
        item2, created2 = square_service._upsert_item(
            db, test_user.id, var, qty=3, parent_name="Cap", run=run2
        )
        db.flush()

        assert created2 is False
        assert item2.id == item.id

        # Exactly one import_adjust entry
        count = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
            InventoryStockLedger.event_type == "import_adjust",
        ).count()
        assert count == 1


# ─── TestSquareSyncResult ─────────────────────────────────────────────────────

class TestSquareSyncResult:
    """Tests for _do_sync (full sync path) with mocked HTTP calls."""

    def _seed_cred(self, db, user_id):
        return _make_credential(db, user_id)

    @pytest.mark.asyncio
    async def test_successful_sync_creates_completed_run(self, db, test_user):
        self._seed_cred(db, test_user.id)

        catalog = [_catalog_item("IT1", "Jacket", [_variation("VAR_A", "Small")])]
        counts = {"VAR_A": 10}

        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=catalog)),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value=counts)),
        ):
            result = await square_service.sync(db, test_user.id)

        assert isinstance(result, SyncResult)
        assert result.items_imported == 1
        assert result.items_updated == 0
        assert result.errors_count == 0

        run = db.query(ProviderSyncRun).filter(ProviderSyncRun.id == result.run_id).one()
        assert run.status == "completed"
        assert run.provider == "square"
        assert run.items_imported == 1
        assert run.completed_at is not None

    @pytest.mark.asyncio
    async def test_resync_updates_existing_item(self, db, test_user):
        self._seed_cred(db, test_user.id)
        catalog = [_catalog_item("IT2", "Pants", [_variation("VAR_B", "32x32")])]
        counts_first = {"VAR_B": 5}
        counts_second = {"VAR_B": 3}

        # First sync
        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=catalog)),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value=counts_first)),
        ):
            result1 = await square_service.sync(db, test_user.id)

        assert result1.items_imported == 1

        # Second sync — quantity changed
        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=catalog)),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value=counts_second)),
        ):
            result2 = await square_service.sync(db, test_user.id)

        assert result2.items_imported == 0
        assert result2.items_updated == 1
        assert result2.errors_count == 0

        item = db.query(InventoryItem).filter(
            InventoryItem.external_id == "VAR_B",
            InventoryItem.user_id == test_user.id,
        ).one()
        assert item.quantity == 3

        # Check sync ledger entry
        sync_entry = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id,
            InventoryStockLedger.event_type == "sync",
        ).one()
        assert sync_entry.delta_quantity == -2

    @pytest.mark.asyncio
    async def test_sync_with_no_catalog_creates_zero_counter_run(self, db, test_user):
        self._seed_cred(db, test_user.id)

        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=[])),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value={})),
        ):
            result = await square_service.sync(db, test_user.id)

        assert result.items_imported == 0
        assert result.items_updated == 0
        assert result.errors_count == 0

        run = db.query(ProviderSyncRun).filter(ProviderSyncRun.id == result.run_id).one()
        assert run.status == "completed"

    @pytest.mark.asyncio
    async def test_partial_sync_when_some_variations_skip(self, db, test_user):
        self._seed_cred(db, test_user.id)

        # Mix of valid and invalid variations
        bad_var = {"type": "ITEM_VARIATION", "item_variation_data": {"name": "No ID"}}
        catalog = [_catalog_item("IT3", "Bag", [_variation("VAR_C"), bad_var])]
        counts = {"VAR_C": 2}

        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=catalog)),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value=counts)),
        ):
            result = await square_service.sync(db, test_user.id)

        assert result.items_imported == 1
        assert result.items_skipped == 1
        assert result.errors_count == 1

        run = db.query(ProviderSyncRun).filter(ProviderSyncRun.id == result.run_id).one()
        assert run.status == "partial"

    @pytest.mark.asyncio
    async def test_unhandled_exception_records_import_error_issue(self, db, test_user):
        self._seed_cred(db, test_user.id)
        catalog = [_catalog_item("IT4", "Shoe", [_variation("VAR_D")])]
        counts = {"VAR_D": 1}

        original_upsert = square_service._upsert_item

        def boom(db_, user_id_, variation, qty, parent_name, run):
            raise ValueError("Simulated DB error")

        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=catalog)),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value=counts)),
            patch.object(square_service, "_upsert_item", side_effect=boom),
        ):
            result = await square_service.sync(db, test_user.id)

        assert result.errors_count == 1

        issue = db.query(ReconciliationIssue).filter(
            ReconciliationIssue.user_id == test_user.id,
            ReconciliationIssue.issue_type == "import_error",
            ReconciliationIssue.severity == "error",
        ).first()
        assert issue is not None
        assert "Simulated DB error" in issue.details.get("error", "")

    @pytest.mark.asyncio
    async def test_sync_without_credentials_raises(self, db, test_user):
        """Calling _do_sync when no credential exists should raise RuntimeError."""
        from app.services.providers.base import SyncRunManager

        run = SyncRunManager.start(db, "square", test_user.id)
        with pytest.raises(RuntimeError, match="Square credentials not found"):
            await square_service._do_sync(db, test_user.id, run)

    @pytest.mark.asyncio
    async def test_multi_variation_item_creates_multiple_inventory_items(self, db, test_user):
        self._seed_cred(db, test_user.id)
        catalog = [
            _catalog_item(
                "IT5",
                "Sneaker",
                [
                    _variation("VAR_S", "Size 10"),
                    _variation("VAR_M", "Size 11"),
                    _variation("VAR_L", "Size 12"),
                ],
            )
        ]
        counts = {"VAR_S": 2, "VAR_M": 5, "VAR_L": 0}

        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=catalog)),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value=counts)),
        ):
            result = await square_service.sync(db, test_user.id)

        assert result.items_imported == 3
        assert result.errors_count == 0

        items = (
            db.query(InventoryItem)
            .filter(
                InventoryItem.user_id == test_user.id,
                InventoryItem.source == "square",
            )
            .all()
        )
        assert len(items) == 3
        names = {i.name for i in items}
        assert "Sneaker - Size 10" in names
        assert "Sneaker - Size 11" in names
        assert "Sneaker - Size 12" in names

    @pytest.mark.asyncio
    async def test_idempotent_repeat_sync_no_duplicate_items(self, db, test_user):
        """Running sync twice on the same catalog creates items only once."""
        self._seed_cred(db, test_user.id)
        catalog = [_catalog_item("IT6", "Cap", [_variation("VAR_IDEM2")])]
        counts = {"VAR_IDEM2": 4}

        mock_kwargs = dict(
            _fetch_catalog=AsyncMock(return_value=catalog),
            _fetch_inventory_counts=AsyncMock(return_value=counts),
        )

        with (
            patch.object(square_service, "_fetch_catalog", new=mock_kwargs["_fetch_catalog"]),
            patch.object(square_service, "_fetch_inventory_counts", new=mock_kwargs["_fetch_inventory_counts"]),
        ):
            await square_service.sync(db, test_user.id)

        # Reset mocks for second sync
        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=catalog)),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value=counts)),
        ):
            result2 = await square_service.sync(db, test_user.id)

        assert result2.items_imported == 0   # no new items
        assert result2.items_updated == 1    # same item updated
        assert result2.errors_count == 0

        item_count = (
            db.query(InventoryItem)
            .filter(
                InventoryItem.user_id == test_user.id,
                InventoryItem.external_id == "VAR_IDEM2",
            )
            .count()
        )
        assert item_count == 1


# ─── TestSquareConnectEndpoint ────────────────────────────────────────────────

class TestSquareConnectEndpoint:
    def test_connect_stores_credentials(self, client, auth_headers, db, test_user):
        resp = client.post(
            "/api/v1/integrations/square/connect",
            json={"access_token": "sq_live_TOKEN123", "merchant_id": "MERCH_ABC"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["message"] == "Square account connected."
        assert data["merchant_id"] == "MERCH_ABC"

        cred = db.query(SquareCredential).filter(
            SquareCredential.user_id == test_user.id
        ).one()
        assert decrypt_token(cred.access_token) == "sq_live_TOKEN123"
        assert cred.merchant_id == "MERCH_ABC"

    def test_connect_with_location_id(self, client, auth_headers, db, test_user):
        resp = client.post(
            "/api/v1/integrations/square/connect",
            json={"access_token": "tok", "location_id": "LOC_001"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["location_id"] == "LOC_001"

    def test_connect_updates_existing_credential(self, client, auth_headers, db, test_user):
        _make_credential(db, test_user.id, access_token="old_token", merchant_id="OLD")
        db.commit()

        resp = client.post(
            "/api/v1/integrations/square/connect",
            json={"access_token": "new_token", "merchant_id": "NEW"},
            headers=auth_headers,
        )
        assert resp.status_code == 200

        cred = db.query(SquareCredential).filter(
            SquareCredential.user_id == test_user.id
        ).one()
        assert decrypt_token(cred.access_token) == "new_token"
        assert cred.merchant_id == "NEW"

    def test_status_not_connected(self, client, auth_headers):
        resp = client.get("/api/v1/integrations/square/status", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is False
        assert data["merchant_id"] is None

    def test_status_connected_after_connect(self, client, auth_headers, db, test_user):
        _make_credential(db, test_user.id, merchant_id="MERCH_XYZ")
        db.commit()

        resp = client.get("/api/v1/integrations/square/status", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is True
        assert data["merchant_id"] == "MERCH_XYZ"


# ─── TestSquareSyncEndpoint ───────────────────────────────────────────────────

class TestSquareSyncEndpoint:
    def _seed_cred(self, db, user_id):
        return _make_credential(db, user_id)

    def test_sync_400_when_not_connected(self, client, auth_headers):
        resp = client.post("/api/v1/integrations/square/sync", headers=auth_headers)
        assert resp.status_code == 400
        assert "not connected" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_sync_returns_run_id_and_counters(
        self, client, auth_headers, db, test_user
    ):
        self._seed_cred(db, test_user.id)
        db.commit()

        catalog = [_catalog_item("IT_R1", "Bag", [_variation("VAR_R1")])]
        counts = {"VAR_R1": 3}

        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=catalog)),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value=counts)),
        ):
            resp = client.post("/api/v1/integrations/square/sync", headers=auth_headers)

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

        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=[])),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value={})),
        ):
            resp = client.post("/api/v1/integrations/square/sync", headers=auth_headers)

        assert resp.status_code == 200

        runs_resp = client.get(
            "/api/v1/integrations/sync-runs?provider=square", headers=auth_headers
        )
        assert runs_resp.status_code == 200
        runs = runs_resp.json()
        assert len(runs) >= 1
        assert all(r["provider"] == "square" for r in runs)

    @pytest.mark.asyncio
    async def test_reconciliation_issues_visible_after_sync(
        self, client, auth_headers, db, test_user
    ):
        self._seed_cred(db, test_user.id)
        db.commit()

        # Bad variation triggers an import_error issue
        bad_var = {"type": "ITEM_VARIATION", "item_variation_data": {"name": "No ID"}}
        catalog = [_catalog_item("IT_BAD", "Gadget", [bad_var])]

        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=catalog)),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value={})),
        ):
            client.post("/api/v1/integrations/square/sync", headers=auth_headers)

        issues_resp = client.get(
            "/api/v1/integrations/reconciliation-issues?provider=square",
            headers=auth_headers,
        )
        assert issues_resp.status_code == 200
        issues = issues_resp.json()
        assert len(issues) >= 1
        assert all(i["provider"] == "square" for i in issues)

    @pytest.mark.asyncio
    async def test_sync_does_not_affect_other_provider_runs(
        self, client, auth_headers, db, test_user
    ):
        """Square sync should only appear in sync-runs?provider=square, not lightspeed."""
        self._seed_cred(db, test_user.id)
        db.commit()

        with (
            patch.object(square_service, "_fetch_catalog", new=AsyncMock(return_value=[])),
            patch.object(square_service, "_fetch_inventory_counts", new=AsyncMock(return_value={})),
        ):
            client.post("/api/v1/integrations/square/sync", headers=auth_headers)

        ls_runs = client.get(
            "/api/v1/integrations/sync-runs?provider=lightspeed", headers=auth_headers
        )
        assert ls_runs.status_code == 200
        # No Lightspeed runs should be present
        assert all(r["provider"] == "lightspeed" for r in ls_runs.json())
