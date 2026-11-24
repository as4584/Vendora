"""Seller barcode rules and linked store barcodes.

Revision ID: 036b
Revises: 035
"""
from alembic import op
import sqlalchemy as sa

revision = "036b"
down_revision = "036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "barcode_rules",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("prefix", sa.String(32), nullable=True),
        sa.Column("suffix", sa.String(32), nullable=True),
        sa.Column("min_length", sa.Integer(), nullable=True),
        sa.Column("max_length", sa.Integer(), nullable=True),
        sa.Column("strip_prefix", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("strip_suffix", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("slice_start", sa.Integer(), nullable=True),
        sa.Column("slice_length", sa.Integer(), nullable=True),
        sa.Column("lookup_field", sa.String(10), nullable=False, server_default="auto"),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "lookup_field IN ('auto', 'sku', 'upc', 'linked')", name="ck_barcode_rules_lookup_field"
        ),
    )
    op.create_index("ix_barcode_rules_user_position", "barcode_rules", ["user_id", "position"])

    op.create_table(
        "item_barcodes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "inventory_item_id",
            sa.Uuid(),
            sa.ForeignKey("inventory_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "code", name="uq_item_barcodes_user_code"),
    )
    op.create_index("ix_item_barcodes_item", "item_barcodes", ["inventory_item_id"])


def downgrade() -> None:
    op.drop_index("ix_item_barcodes_item", table_name="item_barcodes")
    op.drop_table("item_barcodes")
    op.drop_index("ix_barcode_rules_user_position", table_name="barcode_rules")
    op.drop_table("barcode_rules")
