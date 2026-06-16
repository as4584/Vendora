"""Add selected size label to invoice items.

Revision ID: 015
Revises: 014
Create Date: 2026-06-16
"""
from alembic import op
import sqlalchemy as sa


revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("invoice_items", sa.Column("size_label", sa.String(50), nullable=True))


def downgrade() -> None:
    op.drop_column("invoice_items", "size_label")
