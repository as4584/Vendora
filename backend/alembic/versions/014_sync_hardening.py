"""Migration 014 — sync hardening tables.

Revision ID: 014
Revises: 013
Create Date: 2026-04-23

Changes:
  1. CREATE TABLE provider_webhook_events
     Idempotent log of raw provider webhook events.  Deduplicates on
     (provider, event_id) so replayed events are ignored.

  2. ADD COLUMN provider_sync_runs.trigger_type  VARCHAR(20)
     How the run was initiated: 'manual' | 'webhook' | 'retry' | 'scheduled'.

  3. ADD COLUMN provider_sync_runs.triggered_by_event_id  UUID NULLABLE FK
     Link from a sync run to the webhook event that started it, if any.

  4. ADD COLUMN reconciliation_issues.resolved_at  TIMESTAMP WITH TIME ZONE
     Already on the model but missing from DB if it wasn't in migration 010.
     Added idempotently via try/except.

  5. ADD COLUMN reconciliation_issues.resolution_note  VARCHAR(500)
     Free-text note set when resolving or dismissing an issue.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. provider_webhook_events ─────────────────────────────────────────────
    op.create_table(
        "provider_webhook_events",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=True),  # nullable: app-level webhooks
        sa.Column(
            "event_id",
            sa.String(255),
            nullable=False,
            comment="Provider-assigned event ID for deduplication",
        ),
        sa.Column("event_type", sa.String(100), nullable=False),
        sa.Column("raw_payload", sa.Text, nullable=True),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("processed", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("sync_run_id", UUID(as_uuid=True), nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.UniqueConstraint("provider", "event_id", name="uq_webhook_events_provider_event_id"),
        sa.ForeignKeyConstraint(
            ["sync_run_id"],
            ["provider_sync_runs.id"],
            ondelete="SET NULL",
            name="fk_webhook_events_sync_run",
        ),
        sa.Index("ix_webhook_events_provider", "provider"),
        sa.Index("ix_webhook_events_received_at", "received_at"),
        sa.Index("ix_webhook_events_processed", "processed"),
    )

    # ── 2. provider_sync_runs.trigger_type ────────────────────────────────────
    op.add_column(
        "provider_sync_runs",
        sa.Column(
            "trigger_type",
            sa.String(20),
            nullable=False,
            server_default="manual",
        ),
    )

    # ── 3. provider_sync_runs.triggered_by_event_id ───────────────────────────
    op.add_column(
        "provider_sync_runs",
        sa.Column(
            "triggered_by_event_id",
            UUID(as_uuid=True),
            sa.ForeignKey("provider_webhook_events.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # ── 4 & 5. reconciliation_issues additions ─────────────────────────────────
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("reconciliation_issues")}

    if "resolved_at" not in existing_cols:
        op.add_column(
            "reconciliation_issues",
            sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        )
    if "resolution_note" not in existing_cols:
        op.add_column(
            "reconciliation_issues",
            sa.Column("resolution_note", sa.String(500), nullable=True),
        )


def downgrade() -> None:
    # Remove columns added to reconciliation_issues
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_cols = {c["name"] for c in inspector.get_columns("reconciliation_issues")}
    if "resolution_note" in existing_cols:
        op.drop_column("reconciliation_issues", "resolution_note")
    if "resolved_at" in existing_cols:
        op.drop_column("reconciliation_issues", "resolved_at")

    op.drop_column("provider_sync_runs", "triggered_by_event_id")
    op.drop_column("provider_sync_runs", "trigger_type")
    op.drop_table("provider_webhook_events")
