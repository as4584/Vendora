"""Add stock ledger, external links, import jobs, and transaction columns.

Revision ID: 009
Revises: 008
Create Date: 2026-04-12

Changes:
  - CREATE TABLE inventory_stock_ledger
  - CREATE TABLE inventory_external_links
  - CREATE TABLE inventory_import_jobs
  - CREATE TABLE inventory_import_rows
  - ALTER TABLE transactions ADD COLUMN invoice_id UUID REFERENCES invoices(id)
  - ALTER TABLE transactions ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1
  - CREATE INDEX ix_transactions_invoice_id ON transactions(invoice_id)

Migration/ORM drift fixes applied 2026-04-23:
  - inventory_stock_ledger:    added updated_at; corrected index names
                               (ix_stock_ledger_item, ix_stock_ledger_user,
                               uq_stock_ledger_idem_key → ix_stock_ledger_item_id,
                               ix_stock_ledger_user_id, ix_stock_ledger_idempotency_key)
  - inventory_external_links:  corrected UniqueConstraint name
                               (uq_ext_link_user_provider_ext → uq_external_link_user_provider);
                               corrected index name (ix_ext_links_item → ix_external_links_item_id);
                               added missing ix_external_links_provider index
  - inventory_import_jobs:     filename varchar(255) → varchar(500); corrected index name
                               (ix_import_jobs_user → ix_import_jobs_user_id)
  - inventory_import_rows:     added updated_at; raw_data nullable → NOT NULL;
                               corrected index name (ix_import_rows_job → ix_import_rows_job_id)
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # inventory_stock_ledger
    # ------------------------------------------------------------------
    op.create_table(
        "inventory_stock_ledger",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("inventory_item_id", UUID(as_uuid=True), sa.ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("delta_quantity", sa.Integer, nullable=False),
        sa.Column("quantity_after", sa.Integer, nullable=False),
        sa.Column(
            "event_type",
            sa.String(50),
            sa.CheckConstraint(
                "event_type IN ('sale','refund','import_adjust','manual_adjust','sync')",
                name="ck_stock_ledger_event_type",
            ),
            nullable=False,
        ),
        sa.Column("source_type", sa.String(50), nullable=True),
        sa.Column("source_id", sa.String(255), nullable=True),
        sa.Column("idempotency_key", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_stock_ledger_item_id", "inventory_stock_ledger", ["inventory_item_id"])
    op.create_index("ix_stock_ledger_user_id", "inventory_stock_ledger", ["user_id"])
    # Partial unique index: idempotency_key must be unique where NOT NULL
    op.execute(
        "CREATE UNIQUE INDEX ix_stock_ledger_idempotency_key "
        "ON inventory_stock_ledger (idempotency_key) "
        "WHERE idempotency_key IS NOT NULL"
    )

    # ------------------------------------------------------------------
    # inventory_external_links
    # ------------------------------------------------------------------
    op.create_table(
        "inventory_external_links",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("inventory_item_id", UUID(as_uuid=True), sa.ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "provider",
            sa.String(50),
            sa.CheckConstraint(
                "provider IN ('lightspeed','square','clover','spreadsheet')",
                name="ck_ext_link_provider",
            ),
            nullable=False,
        ),
        sa.Column("external_id", sa.String(255), nullable=False),
        sa.Column("external_sku", sa.String(255), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("user_id", "provider", "external_id", name="uq_external_link_user_provider"),
    )
    op.create_index("ix_external_links_item_id", "inventory_external_links", ["inventory_item_id"])
    op.create_index("ix_external_links_provider", "inventory_external_links", ["provider"])

    # ------------------------------------------------------------------
    # inventory_import_jobs
    # ------------------------------------------------------------------
    op.create_table(
        "inventory_import_jobs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "status",
            sa.String(20),
            sa.CheckConstraint(
                "status IN ('pending','previewed','committed','failed')",
                name="ck_import_job_status",
            ),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("source", sa.String(50), nullable=False, server_default="spreadsheet"),
        sa.Column("filename", sa.String(500), nullable=True),
        sa.Column("field_mapping", sa.JSON, nullable=True),
        sa.Column("total_rows", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rows_created", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rows_updated", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rows_skipped", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rows_errored", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_import_jobs_user_id", "inventory_import_jobs", ["user_id"])

    # ------------------------------------------------------------------
    # inventory_import_rows
    # ------------------------------------------------------------------
    op.create_table(
        "inventory_import_rows",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("job_id", UUID(as_uuid=True), sa.ForeignKey("inventory_import_jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("row_number", sa.Integer, nullable=False),
        sa.Column("action", sa.String(20), nullable=True),
        sa.Column("inventory_item_id", UUID(as_uuid=True), sa.ForeignKey("inventory_items.id", ondelete="SET NULL"), nullable=True),
        sa.Column("raw_data", sa.JSON, nullable=False),
        sa.Column("mapped_data", sa.JSON, nullable=True),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("match_key", sa.String(100), nullable=True),
        sa.Column("match_value", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_import_rows_job_id", "inventory_import_rows", ["job_id"])

    # ------------------------------------------------------------------
    # transactions — add invoice_id and quantity
    # ------------------------------------------------------------------
    op.add_column(
        "transactions",
        sa.Column("invoice_id", UUID(as_uuid=True), sa.ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column(
        "transactions",
        sa.Column("quantity", sa.Integer, nullable=False, server_default="1"),
    )
    op.create_index("ix_transactions_invoice_id", "transactions", ["invoice_id"])


def downgrade() -> None:
    op.drop_index("ix_transactions_invoice_id", "transactions")
    op.drop_column("transactions", "quantity")
    op.drop_column("transactions", "invoice_id")

    op.drop_index("ix_import_rows_job_id", "inventory_import_rows")
    op.drop_table("inventory_import_rows")

    op.drop_index("ix_import_jobs_user_id", "inventory_import_jobs")
    op.drop_table("inventory_import_jobs")

    op.drop_index("ix_external_links_provider", "inventory_external_links")
    op.drop_index("ix_external_links_item_id", "inventory_external_links")
    op.drop_table("inventory_external_links")

    op.execute("DROP INDEX IF EXISTS ix_stock_ledger_idempotency_key")
    op.drop_index("ix_stock_ledger_user_id", "inventory_stock_ledger")
    op.drop_index("ix_stock_ledger_item_id", "inventory_stock_ledger")
    op.drop_table("inventory_stock_ledger")
