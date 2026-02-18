"""001 Create users and inventory items tables

Revision ID: 001
Revises: None
Create Date: 2026-02-17

Per ARCHITECTURE.md:
  - users table with subscription_tier (free|pro), is_partner boolean
  - inventory_items with status CHECK constraint and state machine enforcement
  - Soft-delete via deleted_at column on both tables
  - pgcrypto for UUID generation
  - Trigger function for updated_at auto-update
  - Composite partial index for stable pagination
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Enable pgcrypto for gen_random_uuid()
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    # Trigger function for updated_at auto-update
    op.execute("""
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ language 'plpgsql'
    """)

    # Users table
    op.create_table(
        "users",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("business_name", sa.String(255), nullable=True),
        sa.Column("subscription_tier", sa.String(20), nullable=False, server_default="free"),
        sa.Column("is_partner", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("stripe_account_id", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("subscription_tier IN ('free', 'pro')", name="ck_users_subscription_tier"),
    )

    op.execute("""
        CREATE TRIGGER update_users_updated_at
            BEFORE UPDATE ON users
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column()
    """)

    # Inventory items table
    op.create_table(
        "inventory_items",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("category", sa.String(100), nullable=True),
        sa.Column("sku", sa.String(100), nullable=True),
        sa.Column("upc", sa.String(50), nullable=True),
        sa.Column("size", sa.String(50), nullable=True),
        sa.Column("color", sa.String(50), nullable=True),
        sa.Column("condition", sa.String(50), nullable=True),
        sa.Column("serial_number", sa.String(100), nullable=True),
        sa.Column("custom_attributes", JSONB, nullable=True, server_default="{}"),
        sa.Column("buy_price", sa.Numeric(10, 2), nullable=True),
        sa.Column("expected_sell_price", sa.Numeric(10, 2), nullable=True),
        sa.Column("actual_sell_price", sa.Numeric(10, 2), nullable=True),
        sa.Column("platform", sa.String(100), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="in_stock"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('in_stock', 'listed', 'sold', 'shipped', 'paid', 'archived')",
            name="ck_inventory_items_status",
        ),
    )

    # Indexes
    op.create_index("ix_inventory_items_user_id", "inventory_items", ["user_id"])
    op.create_index("ix_inventory_items_status", "inventory_items", ["status"])
    op.create_index("ix_inventory_items_category", "inventory_items", ["category"])
    op.create_index("ix_inventory_items_created_at", "inventory_items", ["created_at"])

    # Composite partial index for stable per-user pagination + tier count
    op.execute("""
        CREATE INDEX ix_inventory_user_created
            ON inventory_items(user_id, created_at DESC)
            WHERE deleted_at IS NULL
    """)

    op.execute("""
        CREATE TRIGGER update_inventory_items_updated_at
            BEFORE UPDATE ON inventory_items
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column()
    """)


def downgrade() -> None:
    op.drop_table("inventory_items")
    op.drop_table("users")
    op.execute("DROP FUNCTION IF EXISTS update_updated_at_column")
