"""Add invoice branding fields to users.

Revision ID: 019
Revises: 018
"""
from alembic import op
import sqlalchemy as sa

revision = "019"
down_revision = "018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("business_address", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("business_phone", sa.String(length=40), nullable=True))
    op.add_column("users", sa.Column("invoice_accent_color", sa.String(length=9), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "invoice_accent_color")
    op.drop_column("users", "business_phone")
    op.drop_column("users", "business_address")
