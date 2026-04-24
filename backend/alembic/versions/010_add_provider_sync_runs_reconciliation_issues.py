"""Add provider_sync_runs and reconciliation_issues tables.

Revision ID: 010
Revises: 009
Create Date: 2026-04-23

Changes:
  - CREATE TABLE provider_sync_runs
  - CREATE TABLE reconciliation_issues
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # provider_sync_runs
    # ------------------------------------------------------------------
    op.create_table(
        "provider_sync_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("account_id", sa.String(255), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "status",
            sa.String(20),
            sa.CheckConstraint(
                "status IN ('running','completed','partial','failed')",
                name="ck_provider_sync_runs_status",
            ),
            nullable=False,
            server_default="running",
        ),
        sa.Column("items_imported", sa.Integer, nullable=False, server_default="0"),
        sa.Column("items_updated", sa.Integer, nullable=False, server_default="0"),
        sa.Column("items_skipped", sa.Integer, nullable=False, server_default="0"),
        sa.Column("transactions_imported", sa.Integer, nullable=False, server_default="0"),
        sa.Column("transactions_updated", sa.Integer, nullable=False, server_default="0"),
        sa.Column("errors_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("metadata", sa.JSON, nullable=True),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.CheckConstraint(
            "provider IN ('lightspeed','square','clover','spreadsheet')",
            name="ck_provider_sync_runs_provider",
        ),
    )
    op.create_index("ix_provider_sync_runs_user_id", "provider_sync_runs", ["user_id"])
    op.create_index("ix_provider_sync_runs_provider", "provider_sync_runs", ["provider"])
    op.create_index("ix_provider_sync_runs_started_at", "provider_sync_runs", ["started_at"])

    # ------------------------------------------------------------------
    # reconciliation_issues
    # ------------------------------------------------------------------
    op.create_table(
        "reconciliation_issues",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("inventory_item_id", UUID(as_uuid=True), sa.ForeignKey("inventory_items.id", ondelete="SET NULL"), nullable=True),
        sa.Column("sync_run_id", UUID(as_uuid=True), sa.ForeignKey("provider_sync_runs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("external_id", sa.String(255), nullable=True),
        sa.Column(
            "issue_type",
            sa.String(50),
            sa.CheckConstraint(
                "issue_type IN ('stale_link','stock_drift','missing_item',"
                "'duplicate_external_id','import_error','unknown')",
                name="ck_recon_issues_type",
            ),
            nullable=False,
        ),
        sa.Column(
            "severity",
            sa.String(20),
            sa.CheckConstraint(
                "severity IN ('info','warning','error')",
                name="ck_recon_issues_severity",
            ),
            nullable=False,
            server_default="warning",
        ),
        sa.Column(
            "status",
            sa.String(20),
            sa.CheckConstraint(
                "status IN ('open','resolved','dismissed')",
                name="ck_recon_issues_status",
            ),
            nullable=False,
            server_default="open",
        ),
        sa.Column("details", sa.JSON, nullable=True),
        sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "provider IN ('lightspeed','square','clover','spreadsheet')",
            name="ck_recon_issues_provider",
        ),
    )
    op.create_index("ix_recon_issues_user_id", "reconciliation_issues", ["user_id"])
    op.create_index("ix_recon_issues_provider", "reconciliation_issues", ["provider"])
    op.create_index("ix_recon_issues_status", "reconciliation_issues", ["status"])


def downgrade() -> None:
    op.drop_index("ix_recon_issues_status", "reconciliation_issues")
    op.drop_index("ix_recon_issues_provider", "reconciliation_issues")
    op.drop_index("ix_recon_issues_user_id", "reconciliation_issues")
    op.drop_table("reconciliation_issues")

    op.drop_index("ix_provider_sync_runs_started_at", "provider_sync_runs")
    op.drop_index("ix_provider_sync_runs_provider", "provider_sync_runs")
    op.drop_index("ix_provider_sync_runs_user_id", "provider_sync_runs")
    op.drop_table("provider_sync_runs")
