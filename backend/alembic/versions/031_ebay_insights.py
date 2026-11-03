"""eBay insights: order fees, payouts, listing traffic cache.

Revision ID: 031
Revises: 030

"""
from alembic import op
import sqlalchemy as sa

revision = "031"
down_revision = "030"
branch_labels = None
depends_on = None


def _ts():
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "ebay_order_fees",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("transaction_id", sa.Uuid(), sa.ForeignKey("transactions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("order_id", sa.String(100), nullable=False),
        sa.Column("final_value_fee", sa.Numeric(10, 2), nullable=False, server_default="0.00"),
        sa.Column("ad_fee", sa.Numeric(10, 2), nullable=False, server_default="0.00"),
        sa.Column("shipping_label", sa.Numeric(10, 2), nullable=False, server_default="0.00"),
        sa.Column("other_fees", sa.Numeric(10, 2), nullable=False, server_default="0.00"),
        sa.Column("total_fees", sa.Numeric(10, 2), nullable=False, server_default="0.00"),
        sa.Column("sale_net", sa.Numeric(10, 2), nullable=True),
        sa.Column("payout_id", sa.String(100), nullable=True),
        sa.Column("lines", sa.JSON(), nullable=True),
        *_ts(),
    )
    op.create_index("uq_ebay_order_fees_user_order", "ebay_order_fees", ["user_id", "order_id"], unique=True)
    op.create_index("ix_ebay_order_fees_payout", "ebay_order_fees", ["user_id", "payout_id"])

    op.create_table(
        "ebay_payouts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("payout_id", sa.String(100), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("status", sa.String(30), nullable=True),
        sa.Column("payout_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("transaction_count", sa.Integer(), nullable=True),
        sa.Column("ebay_net", sa.Numeric(12, 2), nullable=True),
        sa.Column("resqlo_net", sa.Numeric(12, 2), nullable=True),
        sa.Column("orders_matched", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("orders_missing", sa.Integer(), nullable=False, server_default="0"),
        *_ts(),
    )
    op.create_index("uq_ebay_payouts_user_payout", "ebay_payouts", ["user_id", "payout_id"], unique=True)

    op.create_table(
        "ebay_listing_traffic",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "inventory_item_id", sa.Uuid(), sa.ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("listing_id", sa.String(64), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("views", sa.Integer(), nullable=True),
        sa.Column("impressions", sa.Integer(), nullable=True),
        sa.Column("click_through_rate", sa.Numeric(7, 4), nullable=True),
        sa.Column("conversion_rate", sa.Numeric(7, 4), nullable=True),
        sa.Column("sales", sa.Integer(), nullable=True),
        sa.Column("watchers", sa.Integer(), nullable=True),
        *_ts(),
    )
    op.create_index(
        "uq_ebay_traffic_listing_day", "ebay_listing_traffic", ["user_id", "listing_id", "day"], unique=True
    )
    op.create_index("ix_ebay_traffic_item", "ebay_listing_traffic", ["inventory_item_id"])


def downgrade() -> None:
    op.drop_index("ix_ebay_traffic_item", table_name="ebay_listing_traffic")
    op.drop_index("uq_ebay_traffic_listing_day", table_name="ebay_listing_traffic")
    op.drop_table("ebay_listing_traffic")
    op.drop_index("uq_ebay_payouts_user_payout", table_name="ebay_payouts")
    op.drop_table("ebay_payouts")
    op.drop_index("ix_ebay_order_fees_payout", table_name="ebay_order_fees")
    op.drop_index("uq_ebay_order_fees_user_order", table_name="ebay_order_fees")
    op.drop_table("ebay_order_fees")
