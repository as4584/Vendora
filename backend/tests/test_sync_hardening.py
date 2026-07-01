"""Tests for production hardening: webhooks, retry, reconciliation, health, payments.

Covers:
  TestWebhookIdempotency      — duplicate event suppression
  TestSquareWebhookEndpoint   — HMAC verification, event routing
  TestSyncRetry               — retry creates a new run with trigger_type='retry'
  TestReconciliationResolution— PATCH with resolution_note, resolved_at set
  TestProviderHealth          — /health returns per-provider summary
  TestSquarePaymentImport     — _upsert_payment creates/updates Transaction rows
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import uuid
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest

from app.models.provider import ProviderSyncRun, ReconciliationIssue, ProviderWebhookEvent
from app.models.square import SquareCredential
from app.models.transaction import Transaction
from app.security.token_encryption import encrypt_token
from app.services.providers.base import record_webhook_event, is_duplicate_event
from app.services.square import SquareService


# ─── Webhook idempotency ──────────────────────────────────────────────────────

class TestWebhookIdempotency:
    def test_record_webhook_event_first_call_creates_row(self, db, test_user):
        event_id = str(uuid.uuid4())
        evt = record_webhook_event(
            db, "square", event_id, "inventory.count.updated", '{"type":"test"}', test_user.id
        )
        db.commit()
        assert evt.id is not None
        assert evt.provider == "square"
        assert evt.event_id == event_id
        assert evt.processed is False

    def test_record_webhook_event_duplicate_returns_existing(self, db, test_user):
        event_id = str(uuid.uuid4())
        evt1 = record_webhook_event(
            db, "square", event_id, "inventory.count.updated", "{}", test_user.id
        )
        db.commit()
        evt2 = record_webhook_event(
            db, "square", event_id, "inventory.count.updated", "{}", test_user.id
        )
        db.commit()
        assert evt1.id == evt2.id

    def test_is_duplicate_event_false_for_new(self, db):
        assert is_duplicate_event(db, "square", str(uuid.uuid4())) is False

    def test_is_duplicate_event_true_after_insert(self, db, test_user):
        event_id = str(uuid.uuid4())
        record_webhook_event(db, "square", event_id, "catalog.version.updated", "{}", test_user.id)
        db.commit()
        assert is_duplicate_event(db, "square", event_id) is True

    def test_different_provider_same_event_id_not_duplicate(self, db, test_user):
        event_id = str(uuid.uuid4())
        record_webhook_event(db, "square", event_id, "catalog.version.updated", "{}", test_user.id)
        db.commit()
        assert is_duplicate_event(db, "clover", event_id) is False


# ─── Square webhook endpoint ──────────────────────────────────────────────────

class TestSquareWebhookEndpoint:
    """Tests for POST /integrations/square/webhook.

    This endpoint does NOT require auth — it is called by Square.
    """

    def _make_payload(
        self,
        merchant_id: str,
        event_type: str,
        event_id: str | None = None,
    ) -> dict:
        return {
            "merchant_id": merchant_id,
            "type": event_type,
            "event_id": event_id or str(uuid.uuid4()),
            "data": {"type": "inventory_count", "id": str(uuid.uuid4())},
        }

    def test_production_rejects_unsigned_events_when_key_missing(
        self, client, monkeypatch
    ):
        monkeypatch.setattr("app.routers.integrations.settings.ENVIRONMENT", "production")
        monkeypatch.setattr(
            "app.routers.integrations.settings.SQUARE_WEBHOOK_SIGNATURE_KEY", ""
        )

        resp = client.post(
            "/api/v1/integrations/square/webhook",
            json=self._make_payload("MERCHANT", "inventory.count.updated"),
        )

        assert resp.status_code == 503


    def test_unknown_event_type_returns_200_no_sync(self, client, db, test_user):
        payload = self._make_payload("MERCHANT_UNKNOWN", "order.created")
        resp = client.post("/api/v1/integrations/square/webhook", json=payload)
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_unknown_event_without_id_or_merchant_is_accepted(self, client):
        resp = client.post(
            "/api/v1/integrations/square/webhook",
            json={"type": "order.created", "data": {}},
        )
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok", "event_id": ""}

    def test_duplicate_event_id_returns_200_duplicate(self, client, db, test_user):
        event_id = str(uuid.uuid4())
        payload = self._make_payload("MERCH1", "inventory.count.updated", event_id)
        record_webhook_event(db, "square", event_id, "inventory.count.updated", "{}", test_user.id)
        db.commit()

        resp = client.post("/api/v1/integrations/square/webhook", json=payload)
        assert resp.status_code == 200
        assert resp.json()["status"] == "duplicate"

    def test_concurrent_claim_loser_returns_duplicate(self, client, monkeypatch):
        monkeypatch.setattr("app.routers.integrations.is_duplicate_event", lambda *args: False)
        monkeypatch.setattr(
            "app.routers.integrations.claim_webhook_event",
            lambda *args, **kwargs: (object(), False),
        )
        payload = self._make_payload("MERCHANT", "order.created")
        response = client.post("/api/v1/integrations/square/webhook", json=payload)
        assert response.status_code == 200
        assert response.json()["status"] == "duplicate"

    def test_invalid_json_returns_400(self, client):
        resp = client.post(
            "/api/v1/integrations/square/webhook",
            content=b"not-json",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_actionable_event_requires_event_id(self, client):
        payload = self._make_payload("MERCHANT", "inventory.count.updated")
        payload.pop("event_id")
        response = client.post("/api/v1/integrations/square/webhook", json=payload)
        assert response.status_code == 400
        assert response.json()["detail"] == "Webhook event is missing an id."

    def test_invalid_hmac_returns_403_when_key_set(self, client, monkeypatch):
        monkeypatch.setattr("app.config.settings.SQUARE_WEBHOOK_SIGNATURE_KEY", "test-key-123")
        payload = json.dumps(self._make_payload("MERCH", "inventory.count.updated"))
        resp = client.post(
            "/api/v1/integrations/square/webhook",
            content=payload.encode(),
            headers={
                "Content-Type": "application/json",
                "x-square-hmacsha256-signature": "invalidsig",
            },
        )
        assert resp.status_code == 403

    def test_valid_hmac_passes_when_key_set(self, client, db, test_user, monkeypatch):
        sig_key = "test-key-123"
        monkeypatch.setattr("app.config.settings.SQUARE_WEBHOOK_SIGNATURE_KEY", sig_key)
        monkeypatch.setattr(
            "app.config.settings.SQUARE_WEBHOOK_URL",
            "https://vendora.example/api/v1/integrations/square/webhook",
        )

        cred = SquareCredential(
            user_id=test_user.id,
            merchant_id="MERCHANT_HMAC_TEST",
            access_token=encrypt_token("tok"),
        )
        db.add(cred)
        db.commit()

        payload_dict = self._make_payload("MERCHANT_HMAC_TEST", "catalog.version.updated")
        payload_str = json.dumps(payload_dict)

        url = "https://vendora.example/api/v1/integrations/square/webhook"
        mac = hmac.new(
            sig_key.encode(),
            (url + payload_str).encode(),
            hashlib.sha256,
        )
        sig = base64.b64encode(mac.digest()).decode()

        with patch.object(SquareService, "_fetch_catalog", new=AsyncMock(return_value=[])), \
             patch.object(SquareService, "_fetch_inventory_counts", new=AsyncMock(return_value={})), \
             patch.object(SquareService, "_fetch_payments", new=AsyncMock(return_value=[])):
            resp = client.post(
                "/api/v1/integrations/square/webhook",
                content=payload_str.encode(),
                headers={
                    "Content-Type": "application/json",
                    "x-square-hmacsha256-signature": sig,
                },
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_actionable_event_with_known_merchant_triggers_sync(self, client, db, test_user):
        cred = SquareCredential(
            user_id=test_user.id,
            merchant_id="MERCHANT_SYNC_TRIGGER",
            access_token=encrypt_token("tok"),
        )
        db.add(cred)
        db.commit()

        payload = self._make_payload("MERCHANT_SYNC_TRIGGER", "inventory.count.updated")

        with patch.object(SquareService, "_fetch_catalog", new=AsyncMock(return_value=[])), \
             patch.object(SquareService, "_fetch_inventory_counts", new=AsyncMock(return_value={})), \
             patch.object(SquareService, "_fetch_payments", new=AsyncMock(return_value=[])):
            resp = client.post("/api/v1/integrations/square/webhook", json=payload)

        assert resp.status_code == 200
        evt = db.query(ProviderWebhookEvent).filter_by(
            event_id=payload["event_id"]
        ).first()
        assert evt is not None
        assert evt.processed is True
        assert evt.sync_run_id is not None

    def test_actionable_event_unknown_merchant_records_but_no_sync(self, client, db):
        payload = self._make_payload("UNKNOWN_MERCHANT_XYZ", "inventory.count.updated")
        resp = client.post("/api/v1/integrations/square/webhook", json=payload)
        assert resp.status_code == 200
        evt = db.query(ProviderWebhookEvent).filter_by(
            event_id=payload["event_id"]
        ).first()
        assert evt is not None
        assert evt.processed is False

    def test_sync_failure_is_recorded_and_acknowledged(self, client, db, test_user):
        cred = SquareCredential(
            user_id=test_user.id,
            merchant_id="MERCHANT_FAILED_SYNC",
            access_token=encrypt_token("tok"),
        )
        db.add(cred)
        db.commit()
        payload = self._make_payload("MERCHANT_FAILED_SYNC", "inventory.count.updated")
        with patch.object(SquareService, "sync", new=AsyncMock(side_effect=RuntimeError("sync failed"))):
            resp = client.post("/api/v1/integrations/square/webhook", json=payload)
        assert resp.status_code == 200
        evt = db.query(ProviderWebhookEvent).filter_by(event_id=payload["event_id"]).one()
        assert evt.processed is False
        assert evt.error == "sync failed"


# ─── Sync retry endpoint ──────────────────────────────────────────────────────

class TestSyncRetry:
    def test_retry_creates_new_run_with_trigger_type_retry(
        self, client, auth_headers, db, test_user
    ):
        cred = SquareCredential(
            user_id=test_user.id,
            merchant_id="MERCH_RETRY",
            access_token=encrypt_token("tok"),
        )
        db.add(cred)
        original_run = ProviderSyncRun(
            provider="square",
            user_id=test_user.id,
            status="failed",
            trigger_type="manual",
            error_message="Timeout",
        )
        db.add(original_run)
        db.commit()

        with patch.object(SquareService, "_fetch_catalog", new=AsyncMock(return_value=[])), \
             patch.object(SquareService, "_fetch_inventory_counts", new=AsyncMock(return_value={})), \
             patch.object(SquareService, "_fetch_payments", new=AsyncMock(return_value=[])):
            resp = client.post(
                f"/api/v1/integrations/sync-runs/{original_run.id}/retry",
                headers=auth_headers,
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["message"] == "Square sync retried."
        new_run_id = uuid.UUID(data["new_run_id"])
        assert new_run_id != original_run.id

        new_run = db.query(ProviderSyncRun).filter_by(id=new_run_id).first()
        assert new_run is not None
        assert new_run.trigger_type == "retry"

        db.refresh(original_run)
        assert original_run.status == "failed"

    def test_retry_not_found_returns_404(self, client, auth_headers):
        resp = client.post(
            f"/api/v1/integrations/sync-runs/{uuid.uuid4()}/retry",
            headers=auth_headers,
        )
        assert resp.status_code == 404

    def test_retry_requires_auth(self, client):
        resp = client.post(f"/api/v1/integrations/sync-runs/{uuid.uuid4()}/retry")
        assert resp.status_code == 401


# ─── Reconciliation resolution improvements ───────────────────────────────────

class TestReconciliationResolution:
    def _make_issue(self, db, test_user, **kwargs) -> ReconciliationIssue:
        issue = ReconciliationIssue(
            provider="square",
            user_id=test_user.id,
            issue_type="import_error",
            severity="error",
            status="open",
            **kwargs,
        )
        db.add(issue)
        db.commit()
        return issue

    def test_patch_resolved_sets_resolved_at(self, client, auth_headers, db, test_user):
        issue = self._make_issue(db, test_user)
        resp = client.patch(
            f"/api/v1/integrations/reconciliation-issues/{issue.id}",
            json={"status": "resolved"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "resolved"
        assert data["resolved_at"] is not None

    def test_patch_dismissed_sets_resolved_at(self, client, auth_headers, db, test_user):
        issue = self._make_issue(db, test_user)
        resp = client.patch(
            f"/api/v1/integrations/reconciliation-issues/{issue.id}",
            json={"status": "dismissed"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "dismissed"
        assert data["resolved_at"] is not None

    def test_patch_with_resolution_note(self, client, auth_headers, db, test_user):
        issue = self._make_issue(db, test_user)
        resp = client.patch(
            f"/api/v1/integrations/reconciliation-issues/{issue.id}",
            json={"status": "resolved", "resolution_note": "Fixed manually by ops team."},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["resolution_note"] == "Fixed manually by ops team."

    def test_patch_without_resolution_note_leaves_null(self, client, auth_headers, db, test_user):
        issue = self._make_issue(db, test_user)
        resp = client.patch(
            f"/api/v1/integrations/reconciliation-issues/{issue.id}",
            json={"status": "resolved"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["resolution_note"] is None

    def test_patch_invalid_status_returns_400(self, client, auth_headers, db, test_user):
        issue = self._make_issue(db, test_user)
        resp = client.patch(
            f"/api/v1/integrations/reconciliation-issues/{issue.id}",
            json={"status": "open"},
            headers=auth_headers,
        )
        assert resp.status_code == 400

    def test_resolve_issue_helper(self, db, test_user):
        from app.services.providers.base import ProviderAdapter

        issue = self._make_issue(db, test_user)
        ProviderAdapter.resolve_issue(db, issue, status="resolved", resolution_note="Auto-resolved.")
        db.commit()
        db.refresh(issue)
        assert issue.status == "resolved"
        assert issue.resolved_at is not None
        assert issue.resolution_note == "Auto-resolved."


# ─── Provider health endpoint ─────────────────────────────────────────────────

class TestProviderHealth:
    def test_health_returns_all_three_providers(self, client, auth_headers):
        resp = client.get("/api/v1/integrations/health", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        providers = {entry["provider"] for entry in data["providers"]}
        assert providers == {"lightspeed", "square", "clover"}

    def test_health_with_no_runs_shows_none(self, client, auth_headers):
        resp = client.get("/api/v1/integrations/health", headers=auth_headers)
        data = resp.json()
        for entry in data["providers"]:
            assert entry["last_run_at"] is None
            assert entry["last_run_status"] is None
            assert entry["failed_runs_24h"] == 0
            assert entry["open_issues_count"] == 0

    def test_health_counts_open_issues(self, client, auth_headers, db, test_user):
        for _ in range(3):
            db.add(ReconciliationIssue(
                provider="square",
                user_id=test_user.id,
                issue_type="import_error",
                severity="error",
                status="open",
            ))
        db.commit()

        resp = client.get("/api/v1/integrations/health", headers=auth_headers)
        data = resp.json()
        square = next(e for e in data["providers"] if e["provider"] == "square")
        assert square["open_issues_count"] == 3

    def test_health_shows_last_run(self, client, auth_headers, db, test_user):
        run = ProviderSyncRun(
            provider="clover",
            user_id=test_user.id,
            status="completed",
            trigger_type="manual",
        )
        db.add(run)
        db.commit()

        resp = client.get("/api/v1/integrations/health", headers=auth_headers)
        data = resp.json()
        clover = next(e for e in data["providers"] if e["provider"] == "clover")
        assert clover["last_run_status"] == "completed"
        assert clover["last_run_at"] is not None

    def test_health_requires_auth(self, client):
        resp = client.get("/api/v1/integrations/health")
        assert resp.status_code == 401


# ─── Square payment import ────────────────────────────────────────────────────

class TestSquarePaymentImport:
    def _make_payment(
        self,
        payment_id: str | None = None,
        amount_cents: int = 1000,
        status: str = "COMPLETED",
    ) -> dict:
        return {
            "id": payment_id or str(uuid.uuid4()),
            "status": status,
            "total_money": {"amount": amount_cents, "currency": "USD"},
            "created_at": "2024-03-15T12:00:00Z",
            "location_id": "LOC1",
        }

    def test_upsert_payment_creates_transaction(self, db, test_user):
        svc = SquareService()
        run = ProviderSyncRun(
            provider="square", user_id=test_user.id, status="running", trigger_type="manual"
        )
        db.add(run)
        db.flush()

        payment = self._make_payment(amount_cents=2500)
        txn, created = svc._upsert_payment(db, test_user.id, payment, run)
        db.commit()

        assert created is True
        assert txn is not None
        assert txn.source == "square"
        assert txn.gross_amount == Decimal("25.00")
        assert txn.status == "completed"
        assert txn.external_reference_id == payment["id"]

    def test_upsert_payment_idempotent_on_re_sync(self, db, test_user):
        svc = SquareService()
        run = ProviderSyncRun(
            provider="square", user_id=test_user.id, status="running", trigger_type="manual"
        )
        db.add(run)
        db.flush()

        payment = self._make_payment(payment_id="PYMT_IDEM_123", amount_cents=1000)
        txn1, created1 = svc._upsert_payment(db, test_user.id, payment, run)
        db.commit()

        payment["total_money"]["amount"] = 1500
        txn2, created2 = svc._upsert_payment(db, test_user.id, payment, run)
        db.commit()

        assert created1 is True
        assert created2 is False
        assert txn1.id == txn2.id
        db.refresh(txn1)
        assert txn1.gross_amount == Decimal("15.00")

    def test_upsert_payment_canceled_maps_to_refunded(self, db, test_user):
        svc = SquareService()
        run = ProviderSyncRun(
            provider="square", user_id=test_user.id, status="running", trigger_type="manual"
        )
        db.add(run)
        db.flush()

        payment = self._make_payment(status="CANCELED")
        txn, created = svc._upsert_payment(db, test_user.id, payment, run)
        db.commit()
        assert txn.status == "refunded"

    def test_upsert_payment_missing_id_returns_none(self, db, test_user):
        svc = SquareService()
        run = ProviderSyncRun(
            provider="square", user_id=test_user.id, status="running", trigger_type="manual"
        )
        db.add(run)
        db.flush()

        txn, created = svc._upsert_payment(db, test_user.id, {"status": "COMPLETED"}, run)
        assert txn is None
        assert created is False

    def test_full_sync_imports_payments(self, db, test_user):
        cred = SquareCredential(
            user_id=test_user.id,
            merchant_id="MERCH_PAY_TEST",
            access_token=encrypt_token("tok"),
        )
        db.add(cred)
        db.commit()

        fake_payments = [
            self._make_payment(payment_id="P1", amount_cents=500),
            self._make_payment(payment_id="P2", amount_cents=750),
        ]

        svc = SquareService()
        with patch.object(SquareService, "_fetch_catalog", new=AsyncMock(return_value=[])), \
             patch.object(SquareService, "_fetch_inventory_counts", new=AsyncMock(return_value={})), \
             patch.object(SquareService, "_fetch_payments", new=AsyncMock(return_value=fake_payments)):
            result = asyncio.get_event_loop().run_until_complete(svc.sync(db, test_user.id))

        assert result.transactions_imported == 2
        assert result.transactions_updated == 0

        txns = db.query(Transaction).filter_by(user_id=test_user.id, source="square").all()
        payment_ids = {t.external_reference_id for t in txns}
        assert "P1" in payment_ids
        assert "P2" in payment_ids

    def test_sync_run_has_trigger_type_manual_by_default(self, db, test_user):
        cred = SquareCredential(
            user_id=test_user.id,
            merchant_id="MERCH_TRIGGER_TEST",
            access_token=encrypt_token("tok"),
        )
        db.add(cred)
        db.commit()

        svc = SquareService()
        with patch.object(SquareService, "_fetch_catalog", new=AsyncMock(return_value=[])), \
             patch.object(SquareService, "_fetch_inventory_counts", new=AsyncMock(return_value={})), \
             patch.object(SquareService, "_fetch_payments", new=AsyncMock(return_value=[])):
            result = asyncio.get_event_loop().run_until_complete(svc.sync(db, test_user.id))

        run = db.query(ProviderSyncRun).filter_by(id=result.run_id).first()
        assert run.trigger_type == "manual"
