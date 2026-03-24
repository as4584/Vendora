"""Add profile_picture column to users.

Revision ID: 004
Revises: 003
Create Date: 2026-02-23
"""
from alembic import op
import sqlalchemy as sa


revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("profile_picture", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "profile_picture")
