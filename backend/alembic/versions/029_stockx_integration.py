"""StockX integration: tokens, listings, market-data cache, provider outbox.

Also allows provider='stockx' in the provider check constraints and adds
external_parent_id / variant_label to inventory_external_links (StockX links a
variant id that belongs to a product id and maps to one local size).

NOTE: an eBay branch also adds a provider outbox. If both land, reconcile into
one ``provider_outbox`` table (this one is already generic: provider column).

Revision ID: 029
Revises: 028
"""
from alembic import op
import sqlalchemy as sa

revision = "029"
down_revision = "028"
branch_labels = None
depends_on = None

OLD_PROVIDERS = "provider IN ('lightspeed','square','clover','ebay','spreadsheet')"
NEW_PROVIDERS = "provider IN ('lightspeed','square','clover','ebay','stockx','spreadsheet')"

CONSTRAINTS = [
    ("inventory_external_links", "ck_ext_link_provider"),
    ("provider_sync_runs", "ck_provider_sync_runs_provider"),
    ("reconciliation_issues", "ck_recon_issues_provider"),
]


def _timestamps():
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    ]


def upgrade() -> None:
    for table, name in CONSTRAINTS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, NEW_PROVIDERS)

    op.add_column("inventory_external_links", sa.Column("external_parent_id", sa.String(255), nullable=True))
    op.add_column("inventory_external_links", sa.Column("variant_label", sa.String(50), nullable=True))

    op.create_table(
        "stockx_tokens",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("account_id", sa.String(255), nullable=True),
        sa.Column("access_token", sa.String(8192), nullable=False),
        sa.Column("refresh_token", sa.String(4096), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scopes", sa.String(1024), nullable=True),
        *_timestamps(),
    )
    op.create_index("ix_stockx_tokens_user_id", "stockx_tokens", ["user_id"], unique=True)

    op.create_table(
        "stockx_listings",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "inventory_item_id", sa.Uuid(),
            sa.ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("product_id", sa.String(100), nullable=False),
        sa.Column("variant_id", sa.String(100), nullable=False),
        sa.Column("size", sa.String(50), nullable=True),
        sa.Column("listing_id", sa.String(100), nullable=True),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("currency_code", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("last_error", sa.Text(), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "status IN ('pending','active','inactive','deleted','sold','failed')",
            name="ck_stockx_listings_status",
        ),
    )
    op.create_index("ix_stockx_listings_user_id", "stockx_listings", ["user_id"])
    op.create_index("ix_stockx_listings_item_id", "stockx_listings", ["inventory_item_id"])
    op.create_index(
        "uq_stockx_listings_listing_id", "stockx_listings", ["listing_id"], unique=True,
        postgresql_where=sa.text("listing_id IS NOT NULL"),
    )

    op.create_table(
        "stockx_market_cache",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("product_id", sa.String(100), nullable=False),
        sa.Column("variant_id", sa.String(100), nullable=False),
        sa.Column("currency_code", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("lowest_ask", sa.Numeric(10, 2), nullable=True),
        sa.Column("highest_bid", sa.Numeric(10, 2), nullable=True),
        sa.Column("last_sale", sa.Numeric(10, 2), nullable=True),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "uq_stockx_market_cache_variant", "stockx_market_cache",
        ["variant_id", "currency_code"], unique=True,
    )

    op.create_table(
        "provider_outbox",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("action", sa.String(50), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("idempotency_key", sa.String(255), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="6"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "status IN ('pending','processing','done','failed')", name="ck_provider_outbox_status",
        ),
    )
    op.create_index("uq_provider_outbox_idempotency_key", "provider_outbox", ["idempotency_key"], unique=True)
    op.create_index("ix_provider_outbox_user_id", "provider_outbox", ["user_id"])
    op.create_index("ix_provider_outbox_status_next", "provider_outbox", ["status", "next_attempt_at"])


def downgrade() -> None:
    op.drop_table("provider_outbox")
    op.drop_table("stockx_market_cache")
    op.drop_table("stockx_listings")
    op.drop_table("stockx_tokens")
    op.drop_column("inventory_external_links", "variant_label")
    op.drop_column("inventory_external_links", "external_parent_id")
    # Fails if any StockX rows remain in these tables; remove them first.
    for table, name in CONSTRAINTS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, OLD_PROVIDERS)
