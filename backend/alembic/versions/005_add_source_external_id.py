"""Add source and external_id to inventory_items and transactions.

Revision ID: 005
Revises: 004
Create Date: 2026-02-24
"""
from alembic import op
import sqlalchemy as sa

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # inventory_items — source + external_id for Lightspeed dedup
    op.add_column("inventory_items", sa.Column("source", sa.String(50), nullable=True))
    op.add_column("inventory_items", sa.Column("external_id", sa.String(255), nullable=True))
    op.create_index("ix_inventory_items_source", "inventory_items", ["source"])
    op.create_index("ix_inventory_items_external_id", "inventory_items", ["external_id"])
    # Unique constraint so we never duplicate synced items per user+source
    op.create_index(
        "uq_inventory_user_source_external",
        "inventory_items",
        ["user_id", "source", "external_id"],
        unique=True,
        postgresql_where=sa.text("source IS NOT NULL AND external_id IS NOT NULL"),
    )

    # transactions — source for tracking origin
    op.add_column("transactions", sa.Column("source", sa.String(50), nullable=True))
    op.create_index("ix_transactions_source", "transactions", ["source"])
    op.create_index(
        "uq_transactions_user_source_external",
        "transactions",
        ["user_id", "source", "external_reference_id"],
        unique=True,
        postgresql_where=sa.text("source IS NOT NULL AND external_reference_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_transactions_user_source_external", table_name="transactions")
    op.drop_index("ix_transactions_source", table_name="transactions")
    op.drop_column("transactions", "source")

    op.drop_index("uq_inventory_user_source_external", table_name="inventory_items")
    op.drop_index("ix_inventory_items_external_id", table_name="inventory_items")
    op.drop_index("ix_inventory_items_source", table_name="inventory_items")
    op.drop_column("inventory_items", "external_id")
    op.drop_column("inventory_items", "source")
