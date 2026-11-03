"""Freeze cost of goods on each sale; allow "card" as a payment method.

Profit used to subtract buy_price only for items whose status was "sold",
which missed partially sold stock, multi-unit sales, and moved cost to the
day an item was last edited. Each transaction now carries its own cost.

Revision ID: 026
Revises: 025
"""
from alembic import op
import sqlalchemy as sa

revision = "026"
down_revision = "025"
branch_labels = None
depends_on = None

OLD_METHODS = "method IN ('stripe', 'cashapp', 'paypal', 'zelle', 'venmo', 'cash', 'other')"
NEW_METHODS = "method IN ('stripe', 'cashapp', 'paypal', 'zelle', 'venmo', 'cash', 'card', 'other')"


def upgrade() -> None:
    op.add_column("transactions", sa.Column("cost_amount", sa.Numeric(10, 2), nullable=True))
    # Best available history: today's buy price x units sold.
    op.execute("""
        UPDATE transactions AS t
        SET cost_amount = i.buy_price * COALESCE(t.quantity, 1)
        FROM inventory_items AS i
        WHERE t.item_id = i.id AND t.is_refund = false AND i.buy_price IS NOT NULL
    """)
    op.execute("""
        UPDATE transactions AS r
        SET cost_amount = -o.cost_amount
        FROM transactions AS o
        WHERE r.original_transaction_id = o.id AND r.is_refund = true AND o.cost_amount IS NOT NULL
    """)
    op.drop_constraint("ck_transactions_method", "transactions", type_="check")
    op.create_check_constraint("ck_transactions_method", "transactions", NEW_METHODS)


def downgrade() -> None:
    op.execute("UPDATE transactions SET method = 'other' WHERE method = 'card'")
    op.drop_constraint("ck_transactions_method", "transactions", type_="check")
    op.create_check_constraint("ck_transactions_method", "transactions", OLD_METHODS)
    op.drop_column("transactions", "cost_amount")
