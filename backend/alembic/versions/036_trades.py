"""Trades: pairs out + pairs in + cash difference; 'trade' transaction method.

Revision ID: 036
Revises: 035
"""
from alembic import op
import sqlalchemy as sa

revision = "036"
down_revision = "035"
branch_labels = None
depends_on = None

OLD = "method IN ('stripe', 'cashapp', 'paypal', 'zelle', 'venmo', 'cash', 'card', 'other', 'split')"
NEW = "method IN ('stripe', 'cashapp', 'paypal', 'zelle', 'venmo', 'cash', 'card', 'other', 'split', 'trade')"


def upgrade() -> None:
    op.drop_constraint("ck_transactions_method", "transactions", type_="check")
    op.create_check_constraint("ck_transactions_method", "transactions", NEW)
    op.create_table(
        "trades",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("customer_id", sa.Uuid(), sa.ForeignKey("customers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("cash_amount", sa.Numeric(10, 2), nullable=False, server_default="0.00"),
        sa.Column("cash_method", sa.String(20), nullable=True),
        sa.Column("value_out", sa.Numeric(10, 2), nullable=False),
        sa.Column("value_in", sa.Numeric(10, 2), nullable=False),
        sa.Column("received_item_ids", sa.JSON(), nullable=False),
        sa.Column("notes", sa.String(500), nullable=True),
        sa.Column("client_request_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_trades_user_id", "trades", ["user_id"])
    op.create_index("uq_trades_user_request", "trades", ["user_id", "client_request_id"], unique=True,
                    postgresql_where=sa.text("client_request_id IS NOT NULL"))


def downgrade() -> None:
    op.drop_table("trades")
    op.execute("UPDATE transactions SET method = 'other' WHERE method = 'trade'")
    op.drop_constraint("ck_transactions_method", "transactions", type_="check")
    op.create_check_constraint("ck_transactions_method", "transactions", OLD)
