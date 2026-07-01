"""Provider adapter interface and shared sync infrastructure.

Defines:
  - SyncResult        Canonical result shape for every provider sync.
  - SyncRunManager    Manages the ProviderSyncRun lifecycle (start / complete / fail).
  - ProviderAdapter   Abstract base class. Subclasses implement _do_sync().
                      The template sync() method handles run creation and outcome recording.

Design contract:
  Every provider adapter MUST:
    - Set a class-level ``provider`` attribute matching the InventoryExternalLink provider enum.
    - Implement ``is_connected(db, user_id) -> bool``.
    - Implement ``get_connection_id(db, user_id) -> Optional[str]``.
    - Implement ``_do_sync(db, user_id, run) -> SyncResult`` with ``run_id`` set.
    - Call ``self.record_issue(...)`` for any per-item drift detected during _do_sync.
    - Route all quantity mutations through the canonical stock helpers
      (deduct_stock / restore_stock), never direct SQL.

Square and Clover will be import-only adapters — no OAuth, no bidirectional sync.
"""
from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import ClassVar, Optional

from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.models.provider import ProviderSyncRun, ReconciliationIssue


# ─── Canonical sync result ─────────────────────────────────────────────────────

@dataclass
class SyncResult:
    """Canonical result returned by every provider adapter's sync() call.

    ``run_id`` links back to the ProviderSyncRun row so callers can surface it.
    All integer counters default to 0.
    """

    run_id: uuid.UUID
    items_imported: int = 0
    items_updated: int = 0
    items_skipped: int = 0
    transactions_imported: int = 0
    transactions_updated: int = 0
    errors_count: int = 0


# ─── Sync run lifecycle manager ────────────────────────────────────────────────

class SyncRunManager:
    """CRUD helpers for ProviderSyncRun lifecycle.

    Callers should not commit inside these helpers — the adapter template method
    manages commits so that run state is always durable at each lifecycle point.
    """

    @staticmethod
    def start(
        db: Session,
        provider: str,
        user_id: uuid.UUID,
        account_id: Optional[str] = None,
        trigger_type: str = "manual",
        triggered_by_event_id: Optional[uuid.UUID] = None,
    ) -> ProviderSyncRun:
        """Create a 'running' sync run record.  Flushes to populate run.id."""
        run = ProviderSyncRun(
            provider=provider,
            user_id=user_id,
            account_id=account_id,
            started_at=datetime.now(timezone.utc),
            status="running",
            trigger_type=trigger_type,
            triggered_by_event_id=triggered_by_event_id,
        )
        db.add(run)
        db.flush()  # populate PK without committing outer transaction
        return run

    @staticmethod
    def complete(db: Session, run: ProviderSyncRun, result: SyncResult) -> None:
        """Mark run completed (or partial if errors_count > 0) and populate counters."""
        run.status = "completed" if result.errors_count == 0 else "partial"
        run.completed_at = datetime.now(timezone.utc)
        run.items_imported = result.items_imported
        run.items_updated = result.items_updated
        run.items_skipped = result.items_skipped
        run.transactions_imported = result.transactions_imported
        run.transactions_updated = result.transactions_updated
        run.errors_count = result.errors_count
        db.add(run)

    @staticmethod
    def fail(db: Session, run: ProviderSyncRun, error: str) -> None:
        """Mark run failed with an error message (capped at 2 000 chars)."""
        run.status = "failed"
        run.completed_at = datetime.now(timezone.utc)
        run.error_message = error[:2000]
        db.add(run)


# ─── Abstract base adapter ─────────────────────────────────────────────────────

class ProviderAdapter(ABC):
    """Abstract base for provider sync adapters.

    Template method pattern:
      ``sync()`` (concrete) → creates run, calls ``_do_sync()``, marks outcome.
      ``_do_sync()`` (abstract) → provider-specific work; must return SyncResult.

    This guarantees that every adapter produces consistent ProviderSyncRun records
    without boilerplate in each implementation.

    Usage::

        class LightspeedService(ProviderAdapter):
            provider = "lightspeed"

            async def _do_sync(self, db, user_id, run):
                ...
                return SyncResult(run_id=run.id, items_imported=N, ...)

            def is_connected(self, db, user_id): ...
            def get_connection_id(self, db, user_id): ...
    """

    provider: ClassVar[str]

    # ── Abstract interface ─────────────────────────────────────────────────

    @abstractmethod
    def is_connected(self, db: Session, user_id: uuid.UUID) -> bool:
        """Return True if the user has active credentials for this provider."""

    @abstractmethod
    def get_connection_id(self, db: Session, user_id: uuid.UUID) -> Optional[str]:
        """Return the provider account/connection identifier, or None if unknown."""

    @abstractmethod
    async def _do_sync(
        self, db: Session, user_id: uuid.UUID, run: ProviderSyncRun
    ) -> SyncResult:
        """Perform the actual provider-specific sync work.

        Must return a SyncResult with run_id=run.id.
        May call self.record_issue() for any drift detected.
        May commit internally for large batches; the template manages outer commits.
        """

    # ── Template method (do not override) ─────────────────────────────────

    async def sync(
        self,
        db: Session,
        user_id: uuid.UUID,
        trigger_type: str = "manual",
        triggered_by_event_id: Optional[uuid.UUID] = None,
    ) -> SyncResult:
        """Run a full provider sync with automatic run tracking.

        1. Creates a ProviderSyncRun (status=running) and commits it so the
           run is visible even if _do_sync crashes the process mid-way.
        2. Calls _do_sync.
        3. Marks the run completed or partial; commits.
        4. On any unhandled exception: marks run failed; commits; re-raises.
        """
        connection_id = self.get_connection_id(db, user_id)
        run = SyncRunManager.start(
            db,
            self.provider,
            user_id,
            connection_id,
            trigger_type=trigger_type,
            triggered_by_event_id=triggered_by_event_id,
        )
        db.commit()  # persist 'running' state before long-running work starts

        try:
            result = await self._do_sync(db, user_id, run)
            SyncRunManager.complete(db, run, result)
            db.commit()
            return result
        except Exception as exc:
            SyncRunManager.fail(db, run, str(exc))
            db.commit()
            raise

    # ── Shared helpers ─────────────────────────────────────────────────────

    def record_issue(
        self,
        db: Session,
        user_id: uuid.UUID,
        issue_type: str,
        severity: str,
        *,
        run: Optional[ProviderSyncRun] = None,
        inventory_item_id: Optional[uuid.UUID] = None,
        external_id: Optional[str] = None,
        details: Optional[dict] = None,
    ) -> ReconciliationIssue:
        """Record a reconciliation issue detected during sync.

        The issue is added to the session but NOT flushed — callers control
        when the batch is flushed/committed.
        """
        issue = ReconciliationIssue(
            provider=self.provider,
            user_id=user_id,
            inventory_item_id=inventory_item_id,
            external_id=external_id,
            issue_type=issue_type,
            severity=severity,
            status="open",
            details=details,
            detected_at=datetime.now(timezone.utc),
            sync_run_id=run.id if run else None,
        )
        db.add(issue)
        return issue

    @staticmethod
    def resolve_issue(
        db: Session,
        issue: ReconciliationIssue,
        status: str = "resolved",
        resolution_note: Optional[str] = None,
    ) -> None:
        """Transition an open issue to resolved or dismissed.

        Sets resolved_at timestamp automatically.  Call db.commit() after.
        """
        issue.status = status
        issue.resolved_at = datetime.now(timezone.utc)
        if resolution_note is not None:
            issue.resolution_note = resolution_note
        db.add(issue)


# ─── Webhook event helpers (module-level, not per-adapter) ────────────────────

def record_webhook_event(
    db: Session,
    provider: str,
    event_id: str,
    event_type: str,
    raw_payload: str,
    user_id: Optional[uuid.UUID] = None,
) -> "ProviderWebhookEvent":
    """Insert a new webhook event row.

    Idempotent: if a row with the same (provider, event_id) already exists
    the function returns the existing row unchanged (no exception).
    """
    from app.models.provider import ProviderWebhookEvent  # local import avoids circular ref at module level

    event, _ = claim_webhook_event(
        db, provider, event_id, event_type, raw_payload, user_id
    )
    return event


def claim_webhook_event(
    db: Session,
    provider: str,
    event_id: str,
    event_type: str,
    raw_payload: str,
    user_id: Optional[uuid.UUID] = None,
) -> tuple["ProviderWebhookEvent", bool]:
    """Return the event plus whether this caller won the unique insert claim."""
    from app.models.provider import ProviderWebhookEvent

    existing = (
        db.query(ProviderWebhookEvent)
        .filter_by(provider=provider, event_id=event_id)
        .first()
    )
    if existing:
        return existing, False

    event = ProviderWebhookEvent(
        provider=provider,
        user_id=user_id,
        event_id=event_id,
        event_type=event_type,
        raw_payload=raw_payload,
        received_at=datetime.now(timezone.utc),
        processed=False,
    )
    try:
        with db.begin_nested():
            db.add(event)
            db.flush()
        return event, True
    except IntegrityError:
        existing = (
            db.query(ProviderWebhookEvent)
            .filter_by(provider=provider, event_id=event_id)
            .one()
        )
        return existing, False


def is_duplicate_event(db: Session, provider: str, event_id: str) -> bool:
    """Return True if this (provider, event_id) pair has been recorded before."""
    from app.models.provider import ProviderWebhookEvent

    return (
        db.query(ProviderWebhookEvent.id)
        .filter_by(provider=provider, event_id=event_id)
        .first()
        is not None
    )
