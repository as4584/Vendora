"""Provider sync tracking models.

Two tables:
  - provider_sync_runs:       One record per sync attempt; updated on completion/failure.
  - reconciliation_issues:    Detected drift/conflict between a provider and Vendora inventory.
  - provider_webhook_events:  Idempotent log of raw provider webhook events.
"""
import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from sqlalchemy import Column, String, Integer, ForeignKey, Index, CheckConstraint, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.models.base import Base


class ProviderSyncRun(Base):
    """Records one sync attempt from an external provider.

    Lifecycle: created as 'running' → updated to 'completed', 'partial', or 'failed'.
    'partial' means errors_count > 0 but some items were imported successfully.
    """

    __tablename__ = "provider_sync_runs"
    __table_args__ = (
        CheckConstraint(
            "provider IN ('lightspeed','square','clover','spreadsheet')",
            name="ck_provider_sync_runs_provider",
        ),
        CheckConstraint(
            "status IN ('running','completed','partial','failed')",
            name="ck_provider_sync_runs_status",
        ),
        Index("ix_provider_sync_runs_user_id", "user_id"),
        Index("ix_provider_sync_runs_provider", "provider"),
        Index("ix_provider_sync_runs_started_at", "started_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider = Column(String(50), nullable=False)
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Provider-specific account / merchant / connection identifier
    account_id = Column(String(255), nullable=True)
    started_at = Column(
        sa.DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    completed_at = Column(sa.DateTime(timezone=True), nullable=True)
    status = Column(String(20), nullable=False, default="running")
    items_imported = Column(Integer, nullable=False, default=0)
    items_updated = Column(Integer, nullable=False, default=0)
    items_skipped = Column(Integer, nullable=False, default=0)
    transactions_imported = Column(Integer, nullable=False, default=0)
    transactions_updated = Column(Integer, nullable=False, default=0)
    errors_count = Column(Integer, nullable=False, default=0)
    # Free-form summary (e.g. {"pages_fetched": 3, "api_latency_ms": 820})
    metadata_ = Column("metadata", sa.JSON, nullable=True)
    # Populated only when status='failed'
    error_message = Column(Text, nullable=True)
    # How the run was initiated: manual | webhook | retry
    trigger_type = Column(String(20), nullable=False, default="manual")
    triggered_by_event_id = Column(
        UUID(as_uuid=True),
        ForeignKey(
            "provider_webhook_events.id",
            ondelete="SET NULL",
            use_alter=True,
            name="provider_sync_runs_triggered_by_event_id_fkey",
        ),
        nullable=True,
    )


class ReconciliationIssue(Base):
    """A detected mismatch or data quality problem between a provider and Vendora.

    Issues are open until resolved (manually or by a subsequent successful sync).

    issue_type values:
      stale_link          - external link points to a soft-deleted InventoryItem
      stock_drift         - provider qty differs from Vendora ledger qty beyond threshold
      missing_item        - item in Vendora has no matching provider record
      duplicate_external_id - two links share the same provider + external_id
      import_error        - per-item exception during sync
      unknown             - catch-all
    """

    __tablename__ = "reconciliation_issues"
    __table_args__ = (
        CheckConstraint(
            "provider IN ('lightspeed','square','clover','spreadsheet')",
            name="ck_recon_issues_provider",
        ),
        CheckConstraint(
            "issue_type IN ('stale_link','stock_drift','missing_item',"
            "'duplicate_external_id','import_error','unknown')",
            name="ck_recon_issues_type",
        ),
        CheckConstraint(
            "severity IN ('info','warning','error')",
            name="ck_recon_issues_severity",
        ),
        CheckConstraint(
            "status IN ('open','resolved','dismissed')",
            name="ck_recon_issues_status",
        ),
        Index("ix_recon_issues_user_id", "user_id"),
        Index("ix_recon_issues_provider", "provider"),
        Index("ix_recon_issues_status", "status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider = Column(String(50), nullable=False)
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Nullable — issue may not be linked to a specific item yet
    inventory_item_id = Column(
        UUID(as_uuid=True),
        ForeignKey("inventory_items.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Sync run that detected this issue
    sync_run_id = Column(
        UUID(as_uuid=True),
        ForeignKey("provider_sync_runs.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Provider-side identifier that could not be reconciled
    external_id = Column(String(255), nullable=True)
    issue_type = Column(String(50), nullable=False)
    severity = Column(String(20), nullable=False, default="warning")
    status = Column(String(20), nullable=False, default="open")
    # Structured details (e.g. {"vendora_qty": 5, "provider_qty": 3})
    details = Column(sa.JSON, nullable=True)
    detected_at = Column(
        sa.DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    resolved_at = Column(sa.DateTime(timezone=True), nullable=True)
    # Free-text note written when status transitions to resolved/dismissed
    resolution_note = Column(String(500), nullable=True)


class ProviderWebhookEvent(Base):
    """Idempotent log of raw provider webhook events.

    Each event is deduped on (provider, event_id).  A 'processed' flag is set
    to True once the event has triggered a sync run.  'error' captures any
    failure during processing so operators can inspect without trawling logs.

    Supported providers: square (inventory.count.updated, catalog.version.updated).
    Lightspeed and Clover webhook support is a future phase item.
    """

    __tablename__ = "provider_webhook_events"
    __table_args__ = (
        UniqueConstraint(
            "provider", "event_id", name="uq_webhook_events_provider_event_id"
        ),
        Index("ix_webhook_events_provider", "provider"),
        Index("ix_webhook_events_received_at", "received_at"),
        Index("ix_webhook_events_processed", "processed"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider = Column(String(50), nullable=False)
    # Nullable — app-level webhooks may not be associated with a single user
    user_id = Column(UUID(as_uuid=True), nullable=True)
    # Provider-assigned event/notification ID used for deduplication
    event_id = Column(
        String(255),
        nullable=False,
        comment="Provider-assigned event ID for deduplication",
    )
    event_type = Column(String(100), nullable=False)
    # Raw JSON body for audit / replay
    raw_payload = Column(sa.Text, nullable=True)
    received_at = Column(
        sa.DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    processed = Column(sa.Boolean, nullable=False, default=False)
    # Set once the event triggers a sync
    sync_run_id = Column(
        UUID(as_uuid=True),
        ForeignKey("provider_sync_runs.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Populated if processing raised an exception
    error = Column(sa.Text, nullable=True)
