"""Track subscription provider (stripe | apple) for iOS in-app purchases.

Revision ID: 022
Revises: 021
"""
import sqlalchemy as sa
from alembic import op

revision = "022"
down_revision = "021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "subscriptions",
        sa.Column("provider", sa.String(20), nullable=False, server_default="stripe"),
    )
    op.add_column("subscriptions", sa.Column("store_product_id", sa.String(255), nullable=True))
    op.create_check_constraint(
        "ck_subscriptions_provider", "subscriptions", "provider IN ('stripe', 'apple')"
    )
    op.create_index(
        "ix_subscriptions_user_provider_product",
        "subscriptions",
        ["user_id", "provider", "store_product_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_subscriptions_user_provider_product", table_name="subscriptions")
    op.drop_constraint("ck_subscriptions_provider", "subscriptions", type_="check")
    op.drop_column("subscriptions", "store_product_id")
    op.drop_column("subscriptions", "provider")
