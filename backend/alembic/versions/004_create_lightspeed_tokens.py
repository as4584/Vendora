"""Create lightspeed_tokens table for Lightspeed OAuth storage.

Revision ID: 004
Revises: 003
Create Date: 2026-02-23
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "lightspeed_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column("account_id", sa.String(255), nullable=False),
        sa.Column("access_token", sa.String(2048), nullable=False),
        sa.Column("refresh_token", sa.String(2048), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scopes", sa.String(512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_lightspeed_tokens_user_id", "lightspeed_tokens", ["user_id"], unique=True)
    op.create_index("ix_lightspeed_tokens_account_id", "lightspeed_tokens", ["account_id"])

    op.execute(
        """
        CREATE TRIGGER update_lightspeed_tokens_updated_at
            BEFORE UPDATE ON lightspeed_tokens
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS update_lightspeed_tokens_updated_at ON lightspeed_tokens")
    op.drop_index("ix_lightspeed_tokens_account_id", table_name="lightspeed_tokens")
    op.drop_index("ix_lightspeed_tokens_user_id", table_name="lightspeed_tokens")
    op.drop_table("lightspeed_tokens")
