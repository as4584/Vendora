"""Checkout essentials: discounts, sales tax, split payments, size sold.

- transactions.discount_amount / tax_amount: the order-level discount and the
  sales tax collected, allocated per line. gross_amount stays the line's
  revenue AFTER discount and EXCLUDING tax, so profit never counts tax.
- transactions.variant_size: which size variant a line sold.
- "split" payment method for lines of an order paid several ways.
- order_payments: the payment parts of one order (e.g. $200 cash + $85 card).
- users.sales_tax_rate / show_started_at: seller defaults for checkout and
  the end-of-show summary.

Revision ID: 027
Revises: 026
"""
from alembic import op
import sqlalchemy as sa

revision = "027"
down_revision = "026"
branch_labels = None
depends_on = None

OLD_METHODS = "method IN ('stripe', 'cashapp', 'paypal', 'zelle', 'venmo', 'cash', 'card', 'other')"
NEW_METHODS = "method IN ('stripe', 'cashapp', 'paypal', 'zelle', 'venmo', 'cash', 'card', 'other', 'split')"
PART_METHODS = "method IN ('stripe', 'cashapp', 'paypal', 'zelle', 'venmo', 'cash', 'card', 'other')"


def upgrade() -> None:
    op.add_column(
        "transactions",
        sa.Column("discount_amount", sa.Numeric(10, 2), nullable=False, server_default="0.00"),
    )
    op.add_column(
        "transactions",
        sa.Column("tax_amount", sa.Numeric(10, 2), nullable=False, server_default="0.00"),
    )
    op.add_column("transactions", sa.Column("variant_size", sa.String(50), nullable=True))
    op.drop_constraint("ck_transactions_method", "transactions", type_="check")
    op.create_check_constraint("ck_transactions_method", "transactions", NEW_METHODS)

    op.create_table(
        "order_payments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("method", sa.String(20), nullable=False),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(PART_METHODS, name="ck_order_payments_method"),
        sa.CheckConstraint("amount > 0", name="ck_order_payments_amount_positive"),
    )
    op.create_index("ix_order_payments_user_id", "order_payments", ["user_id"])
    op.create_index("ix_order_payments_order_id", "order_payments", ["order_id"])

    op.add_column("users", sa.Column("sales_tax_rate", sa.Numeric(6, 3), nullable=True))
    op.add_column("users", sa.Column("show_started_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "show_started_at")
    op.drop_column("users", "sales_tax_rate")
    op.drop_index("ix_order_payments_order_id", table_name="order_payments")
    op.drop_index("ix_order_payments_user_id", table_name="order_payments")
    op.drop_table("order_payments")
    op.execute("UPDATE transactions SET method = 'other' WHERE method = 'split'")
    op.drop_constraint("ck_transactions_method", "transactions", type_="check")
    op.create_check_constraint("ck_transactions_method", "transactions", OLD_METHODS)
    op.drop_column("transactions", "variant_size")
    op.drop_column("transactions", "tax_amount")
    op.drop_column("transactions", "discount_amount")
