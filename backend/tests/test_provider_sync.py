"""Provider abstraction layer tests.

Coverage:
  - SyncRunManager: start / complete / fail lifecycle
  - ProviderAdapter.sync() template: creates run, updates on completion/failure
  - ReconciliationIssue: creation, resolve, dismiss
  - LightspeedService emits SyncResult through shared provider sync infrastructure
  - Stale link detection creates a reconciliation issue
  - Lightspeed sync run appears in GET /integrations/sync-runs
  - Reconciliation issues appear in GET /integrations/reconciliation-issues
  - PATCH /integrations/reconciliation-issues/{id} resolves an issue
"""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.models.integration import LightspeedToken
from app.models.inventory import InventoryItem, InventoryExternalLink
from app.models.provider import ProviderSyncRun, ReconciliationIssue
from app.services.lightspeed import lightspeed_service
from app.services.providers.base import SyncResult, SyncRunManager


# ─── Fixtures ─────────────────────────────────────────────────────────────────

def _make_token(db, user_id: uuid.UUID, account_id: str = "test_acct") -> LightspeedToken:
    token = LightspeedToken(
        user_id=user_id,
        account_id=account_id,
        access_token="fake_access",
        refresh_token="fake_refresh",
        expires_at=datetime.now(timezone.utc) + timedelta(hours=2),
    )
    db.add(token)
    db.flush()
    return token


def _ls_item_payload(item_id: str = "LS001", qty: int = 5) -> dict:
    return {
        "itemID": item_id,
        "description": f"LS Item {item_id}",
        "systemSku": f"SKU{item_id}",
        "upc": None,
        "qoh": qty,
        "defaultCost": "40.00",
        "Prices": {"ItemPrice": [{"useType": "Default", "amount": "99.00"}]},
        "Category": {"name": "Test"},
    }


def _ls_sale_payload(sale_id: str = "SALE001") -> dict:
    return {
        "saleID": sale_id,
        "total": "99.00",
        "totalTax": "9.00",
        "SaleLines": [],
    }


# ─── SyncRunManager unit tests ────────────────────────────────────────────────

class TestSyncRunManager:
    def test_start_creates_running_run(self, db, test_user):
        run = SyncRunManager.start(db, "lightspeed", test_user.id, account_id="acc1")
        assert run.id is not None
        assert run.status == "running"
        assert run.provider == "lightspeed"
        assert run.user_id == test_user.id
        assert run.account_id == "acc1"
        assert run.started_at is not None
        assert run.completed_at is None

    def test_start_flush_populates_pk(self, db, test_user):
        """run.id must be set after start() so that reconciliation issues can reference it."""
        run = SyncRunManager.start(db, "lightspeed", test_user.id)
        assert isinstance(run.id, uuid.UUID)

    def test_complete_sets_status_and_counters(self, db, test_user):
        run = SyncRunManager.start(db, "lightspeed", test_user.id)
        result = SyncResult(
            run_id=run.id,
            items_imported=3,
            items_updated=1,
            items_skipped=0,
            transactions_imported=2,
            transactions_updated=0,
            errors_count=0,
        )
        SyncRunManager.complete(db, run, result)

        assert run.status == "completed"
        assert run.completed_at is not None
        assert run.items_imported == 3
        assert run.items_updated == 1
        assert run.transactions_imported == 2
        assert run.errors_count == 0

    def test_complete_partial_when_errors_present(self, db, test_user):
        run = SyncRunManager.start(db, "lightspeed", test_user.id)
        result = SyncResult(run_id=run.id, items_imported=2, errors_count=1)
        SyncRunManager.complete(db, run, result)
        assert run.status == "partial"

    def test_fail_sets_failed_status_and_message(self, db, test_user):
        run = SyncRunManager.start(db, "lightspeed", test_user.id)
        SyncRunManager.fail(db, run, "Connection timed out")
        assert run.status == "failed"
        assert run.completed_at is not None
        assert "Connection timed out" in run.error_message

    def test_fail_caps_error_message_at_2000_chars(self, db, test_user):
        run = SyncRunManager.start(db, "lightspeed", test_user.id)
        SyncRunManager.fail(db, run, "x" * 3000)
        assert len(run.error_message) == 2000


# ─── ReconciliationIssue unit tests ──────────────────────────────────────────

class TestReconciliationIssue:
    def test_record_issue_creates_open_issue(self, db, test_user):
        run = SyncRunManager.start(db, "lightspeed", test_user.id)
        issue = lightspeed_service.record_issue(
            db,
            test_user.id,
            issue_type="stale_link",
            severity="warning",
            run=run,
            external_id="LS_EXT_001",
            details={"reason": "item soft-deleted"},
        )
        db.flush()

        stored = db.query(ReconciliationIssue).filter(
            ReconciliationIssue.id == issue.id
        ).first()
        assert stored is not None
        assert stored.status == "open"
        assert stored.provider == "lightspeed"
        assert stored.issue_type == "stale_link"
        assert stored.severity == "warning"
        assert stored.sync_run_id == run.id
        assert stored.external_id == "LS_EXT_001"
        assert stored.details == {"reason": "item soft-deleted"}

    def test_issue_resolved_at_set_on_resolve(self, db, test_user):
        run = SyncRunManager.start(db, "lightspeed", test_user.id)
        issue = lightspeed_service.record_issue(
            db, test_user.id, issue_type="import_error", severity="error", run=run
        )
        db.flush()

        issue.status = "resolved"
        issue.resolved_at = datetime.now(timezone.utc)
        db.add(issue)
        db.flush()

        stored = db.query(ReconciliationIssue).filter(ReconciliationIssue.id == issue.id).first()
        assert stored.status == "resolved"
        assert stored.resolved_at is not None

    def test_issue_without_run_has_null_sync_run_id(self, db, test_user):
        issue = lightspeed_service.record_issue(
            db, test_user.id, issue_type="unknown", severity="info"
        )
        db.flush()
        assert issue.sync_run_id is None


# ─── LightspeedService via ProviderAdapter template ──────────────────────────

class TestLightspeedSyncRunIntegration:
    """Tests Lightspeed sync through the ProviderAdapter template.

    _get_all_pages is patched to avoid real HTTP calls.
    """

    def _seed_token(self, db, user_id):
        return _make_token(db, user_id)

    @pytest.mark.asyncio
    async def test_sync_creates_completed_run(self, db, test_user):
        self._seed_token(db, test_user.id)

        with patch.object(lightspeed_service, "_get_all_pages", new_callable=AsyncMock) as mock_pages:
            mock_pages.return_value = []
            result = await lightspeed_service.sync(db, test_user.id)

        assert isinstance(result, SyncResult)
        assert result.run_id is not None

        run = db.query(ProviderSyncRun).filter(ProviderSyncRun.id == result.run_id).first()
        assert run is not None
        assert run.status == "completed"
        assert run.provider == "lightspeed"
        assert run.user_id == test_user.id
        assert run.completed_at is not None

    @pytest.mark.asyncio
    async def test_sync_counters_match_result(self, db, test_user):
        self._seed_token(db, test_user.id)

        items = [_ls_item_payload("LS001"), _ls_item_payload("LS002")]
        sales = [_ls_sale_payload("SALE001")]

        async def fake_pages(_self_or_token, url, root_key, **kwargs):
            # Called as an instance method through patch.object
            if "Item" in url:
                return items
            return sales

        with patch.object(lightspeed_service, "_get_all_pages", new_callable=AsyncMock) as m:
            m.side_effect = [items, sales]
            result = await lightspeed_service.sync(db, test_user.id)

        assert result.items_imported == 2
        assert result.items_updated == 0
        assert result.transactions_imported == 1
        assert result.errors_count == 0

        run = db.query(ProviderSyncRun).filter(ProviderSyncRun.id == result.run_id).first()
        assert run.items_imported == 2
        assert run.transactions_imported == 1

    @pytest.mark.asyncio
    async def test_stale_link_creates_reconciliation_issue(self, db, test_user):
        """When a linked InventoryItem is soft-deleted, sync records a stale_link issue."""
        self._seed_token(db, test_user.id)

        # Create a soft-deleted item with an external link
        item = InventoryItem(
            user_id=test_user.id,
            name="Deleted Item",
            quantity=3,
            status="in_stock",
            source="lightspeed",
            external_id="LS_STALE",
            deleted_at=datetime.now(timezone.utc),
        )
        db.add(item)
        db.flush()
        db.add(InventoryExternalLink(
            inventory_item_id=item.id,
            user_id=test_user.id,
            provider="lightspeed",
            external_id="LS_STALE",
            last_synced_at=None,
        ))
        db.flush()

        stale_item_payload = _ls_item_payload("LS_STALE")

        with patch.object(lightspeed_service, "_get_all_pages", new_callable=AsyncMock) as m:
            m.side_effect = [[stale_item_payload], []]
            result = await lightspeed_service.sync(db, test_user.id)

        assert result.items_skipped == 1
        assert result.errors_count == 1

        issues = db.query(ReconciliationIssue).filter(
            ReconciliationIssue.user_id == test_user.id,
            ReconciliationIssue.issue_type == "stale_link",
        ).all()
        assert len(issues) == 1
        assert issues[0].sync_run_id == result.run_id
        assert issues[0].external_id == "LS_STALE"
        assert issues[0].status == "open"

    @pytest.mark.asyncio
    async def test_sync_run_is_partial_when_stale_links_exist(self, db, test_user):
        """errors_count > 0 → run.status = 'partial', not 'completed'."""
        self._seed_token(db, test_user.id)

        item = InventoryItem(
            user_id=test_user.id, name="Old", quantity=0, status="sold",
            source="lightspeed", external_id="LS_OLD",
            deleted_at=datetime.now(timezone.utc),
        )
        db.add(item)
        db.flush()
        db.add(InventoryExternalLink(
            inventory_item_id=item.id, user_id=test_user.id,
            provider="lightspeed", external_id="LS_OLD", last_synced_at=None,
        ))
        db.flush()

        with patch.object(lightspeed_service, "_get_all_pages", new_callable=AsyncMock) as m:
            m.side_effect = [[_ls_item_payload("LS_OLD")], []]
            result = await lightspeed_service.sync(db, test_user.id)

        run = db.query(ProviderSyncRun).filter(ProviderSyncRun.id == result.run_id).first()
        assert run.status == "partial"

    @pytest.mark.asyncio
    async def test_sync_failure_marks_run_failed(self, db, test_user):
        """If _do_sync raises, template marks the run as failed and re-raises."""
        self._seed_token(db, test_user.id)

        with patch.object(
            lightspeed_service, "_get_all_pages", new_callable=AsyncMock
        ) as m:
            m.side_effect = RuntimeError("Simulated Lightspeed API crash")
            with pytest.raises(RuntimeError):
                await lightspeed_service.sync(db, test_user.id)

        run = db.query(ProviderSyncRun).filter(
            ProviderSyncRun.user_id == test_user.id,
            ProviderSyncRun.provider == "lightspeed",
        ).order_by(ProviderSyncRun.started_at.desc()).first()
        assert run is not None
        assert run.status == "failed"
        assert "Simulated Lightspeed API crash" in run.error_message


# ─── API endpoint tests ───────────────────────────────────────────────────────

class TestSyncRunsEndpoints:
    def _seed_run(
        self, db, user_id, *, provider="lightspeed", status="completed",
        items_imported=0, errors_count=0,
    ) -> ProviderSyncRun:
        run = ProviderSyncRun(
            provider=provider,
            user_id=user_id,
            account_id="acct_test",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            status=status,
            items_imported=items_imported,
            errors_count=errors_count,
        )
        db.add(run)
        db.flush()
        return run

    def test_list_sync_runs_returns_user_runs(self, client, auth_headers, db, test_user):
        self._seed_run(db, test_user.id, items_imported=5)
        self._seed_run(db, test_user.id, items_imported=3)

        resp = client.get("/api/v1/integrations/sync-runs", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 2
        assert all(r["user_id"] == str(test_user.id) for r in data)

    def test_list_sync_runs_filtered_by_provider(self, client, auth_headers, db, test_user):
        self._seed_run(db, test_user.id, provider="lightspeed")
        self._seed_run(db, test_user.id, provider="square")

        resp = client.get(
            "/api/v1/integrations/sync-runs?provider=lightspeed", headers=auth_headers
        )
        assert resp.status_code == 200
        data = resp.json()
        assert all(r["provider"] == "lightspeed" for r in data)

    def test_get_sync_run_by_id(self, client, auth_headers, db, test_user):
        run = self._seed_run(db, test_user.id, items_imported=7)

        resp = client.get(f"/api/v1/integrations/sync-runs/{run.id}", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == str(run.id)
        assert data["items_imported"] == 7

    def test_get_sync_run_404_for_other_user(
        self, client, auth_headers, second_auth_headers, db, second_user
    ):
        run = self._seed_run(db, second_user.id)

        resp = client.get(f"/api/v1/integrations/sync-runs/{run.id}", headers=auth_headers)
        assert resp.status_code == 404


class TestReconciliationIssuesEndpoints:
    def _seed_issue(
        self, db, user_id, *, issue_type="stale_link", status="open", external_id=None
    ) -> ReconciliationIssue:
        issue = ReconciliationIssue(
            provider="lightspeed",
            user_id=user_id,
            issue_type=issue_type,
            severity="warning",
            status=status,
            external_id=external_id,
            detected_at=datetime.now(timezone.utc),
        )
        db.add(issue)
        db.flush()
        return issue

    def test_list_issues_returns_user_issues(self, client, auth_headers, db, test_user):
        self._seed_issue(db, test_user.id)
        self._seed_issue(db, test_user.id)

        resp = client.get("/api/v1/integrations/reconciliation-issues", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 2

    def test_list_issues_filtered_by_status(self, client, auth_headers, db, test_user):
        self._seed_issue(db, test_user.id, status="open")
        self._seed_issue(db, test_user.id, status="resolved")

        resp = client.get(
            "/api/v1/integrations/reconciliation-issues?status=open", headers=auth_headers
        )
        assert resp.status_code == 200
        data = resp.json()
        assert all(i["status"] == "open" for i in data)

    def test_resolve_issue(self, client, auth_headers, db, test_user):
        issue = self._seed_issue(db, test_user.id, status="open")

        resp = client.patch(
            f"/api/v1/integrations/reconciliation-issues/{issue.id}",
            json={"status": "resolved"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "resolved"
        assert data["resolved_at"] is not None

    def test_dismiss_issue(self, client, auth_headers, db, test_user):
        issue = self._seed_issue(db, test_user.id)

        resp = client.patch(
            f"/api/v1/integrations/reconciliation-issues/{issue.id}",
            json={"status": "dismissed"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "dismissed"

    def test_invalid_status_rejected(self, client, auth_headers, db, test_user):
        issue = self._seed_issue(db, test_user.id)

        resp = client.patch(
            f"/api/v1/integrations/reconciliation-issues/{issue.id}",
            json={"status": "open"},  # not a valid target transition
            headers=auth_headers,
        )
        assert resp.status_code == 400

    def test_cannot_update_other_user_issue(
        self, client, auth_headers, db, second_user
    ):
        issue = self._seed_issue(db, second_user.id)

        resp = client.patch(
            f"/api/v1/integrations/reconciliation-issues/{issue.id}",
            json={"status": "resolved"},
            headers=auth_headers,
        )
        assert resp.status_code == 404
