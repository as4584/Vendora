"""Per-account barcode memory for smart scan.

Revision ID: 025
Revises: 024
"""
from alembic import op
import sqlalchemy as sa

revision = "025"
down_revision = "024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "scan_memory",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("barcode", sa.String(64), nullable=False),
        sa.Column("style_code", sa.String(64), nullable=True),
        sa.Column("fields", sa.JSON(), nullable=False),
        sa.Column("times_seen", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "barcode", name="uq_scan_memory_user_barcode"),
    )
    op.create_index("ix_scan_memory_user_style", "scan_memory", ["user_id", "style_code"])


def downgrade() -> None:
    op.drop_index("ix_scan_memory_user_style", table_name="scan_memory")
    op.drop_table("scan_memory")
