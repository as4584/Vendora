"""Group the lines of one multi-item sale under an order id.

Revision ID: 024
Revises: 023
"""
from alembic import op
import sqlalchemy as sa

revision = "024"
down_revision = "023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("transactions", sa.Column("order_id", sa.Uuid(), nullable=True))
    op.create_index("ix_transactions_order_id", "transactions", ["order_id"])


def downgrade() -> None:
    op.drop_index("ix_transactions_order_id", table_name="transactions")
    op.drop_column("transactions", "order_id")
