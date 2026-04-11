"""Add notes and vendor_name to inventory_items.

Revision ID: 008
Revises: 007
Create Date: 2026-04-11
"""
from alembic import op
import sqlalchemy as sa


revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inventory_items", sa.Column("vendor_name", sa.String(255), nullable=True))
    op.add_column("inventory_items", sa.Column("notes", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("inventory_items", "notes")
    op.drop_column("inventory_items", "vendor_name")
