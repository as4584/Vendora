"""Add ebay_tokens table for the eBay Sell API integration.

Revision ID: 020
Revises: 019
"""
from alembic import op
import sqlalchemy as sa

revision = "020"
down_revision = "019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ebay_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.String(length=255), nullable=True),
        sa.Column("access_token", sa.String(length=4096), nullable=False),
        sa.Column("refresh_token", sa.String(length=4096), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scopes", sa.String(length=1024), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ebay_tokens_user_id", "ebay_tokens", ["user_id"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_ebay_tokens_user_id", table_name="ebay_tokens")
    op.drop_table("ebay_tokens")
