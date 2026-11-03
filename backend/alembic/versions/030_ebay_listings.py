"""eBay listings: offer/listing state on external links, location key, outbox item.

The shared provider_outbox table comes from 029 (StockX); this only adds the
item column eBay quantity pushes coalesce on.

Revision ID: 030
Revises: 029

"""
from alembic import op
import sqlalchemy as sa

revision = "030"
down_revision = "029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inventory_external_links", sa.Column("offer_id", sa.String(64), nullable=True))
    op.add_column("inventory_external_links", sa.Column("listing_id", sa.String(64), nullable=True))
    op.add_column("inventory_external_links", sa.Column("listing_status", sa.String(20), nullable=True))
    op.add_column("inventory_external_links", sa.Column("listed_price", sa.Numeric(10, 2), nullable=True))
    op.add_column("inventory_external_links", sa.Column("listed_quantity", sa.Integer(), nullable=True))
    op.add_column("ebay_tokens", sa.Column("merchant_location_key", sa.String(36), nullable=True))
    op.add_column(
        "provider_outbox",
        sa.Column(
            "inventory_item_id",
            sa.Uuid(),
            sa.ForeignKey("inventory_items.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.create_index("ix_provider_outbox_item", "provider_outbox", ["inventory_item_id"])


def downgrade() -> None:
    op.drop_index("ix_provider_outbox_item", table_name="provider_outbox")
    op.drop_column("provider_outbox", "inventory_item_id")
    op.drop_column("ebay_tokens", "merchant_location_key")
    for col in ("listed_quantity", "listed_price", "listing_status", "listing_id", "offer_id"):
        op.drop_column("inventory_external_links", col)
