"""Add photo_front_url, photo_back_url, and quantity to inventory_items.

Revision ID: 007
Revises: 006
Create Date: 2026-02-25
"""
from alembic import op
import sqlalchemy as sa


revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inventory_items", sa.Column("photo_front_url", sa.Text(), nullable=True))
    op.add_column("inventory_items", sa.Column("photo_back_url", sa.Text(), nullable=True))
    op.add_column(
        "inventory_items",
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
    )


def downgrade() -> None:
    op.drop_column("inventory_items", "quantity")
    op.drop_column("inventory_items", "photo_back_url")
    op.drop_column("inventory_items", "photo_front_url")
