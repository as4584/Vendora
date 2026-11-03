"""Invoice payments (partial/full), partially_paid status, offline create key.

Revision ID: 028
Revises: 027

"""
from alembic import op
import sqlalchemy as sa

revision = "028"
down_revision = "027"
branch_labels = None
depends_on = None

OLD_STATUSES = "status IN ('draft', 'sent', 'paid', 'cancelled')"
NEW_STATUSES = "status IN ('draft', 'sent', 'partially_paid', 'paid', 'cancelled')"


def upgrade() -> None:
    op.add_column("invoices", sa.Column("amount_paid", sa.Numeric(10, 2), nullable=False, server_default="0.00"))
    op.add_column("invoices", sa.Column("client_request_id", sa.String(100), nullable=True))
    op.create_unique_constraint(
        "uq_invoices_user_client_request", "invoices", ["user_id", "client_request_id"]
    )
    # Invoices already paid in full keep reading as paid.
    op.execute("UPDATE invoices SET amount_paid = total WHERE status = 'paid'")
    op.drop_constraint("ck_invoices_status", "invoices", type_="check")
    op.create_check_constraint("ck_invoices_status", "invoices", NEW_STATUSES)
    op.add_column("invoice_items", sa.Column("cost_amount", sa.Numeric(10, 2), nullable=True))

    op.create_table(
        "invoice_payments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("invoice_id", sa.Uuid(), sa.ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("method", sa.String(20), nullable=False),
        sa.Column("note", sa.String(500), nullable=True),
        sa.Column("client_request_id", sa.String(100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_invoice_payments_amount_positive"),
        sa.CheckConstraint(
            "method IN ('cash', 'card', 'zelle', 'venmo', 'cashapp', 'paypal', 'stripe', 'other')",
            name="ck_invoice_payments_method",
        ),
        sa.UniqueConstraint("user_id", "client_request_id", name="uq_invoice_payments_user_client_request"),
    )
    op.create_index("ix_invoice_payments_invoice_id", "invoice_payments", ["invoice_id"])


def downgrade() -> None:
    op.drop_index("ix_invoice_payments_invoice_id", table_name="invoice_payments")
    op.drop_table("invoice_payments")
    op.drop_column("invoice_items", "cost_amount")
    # A partly paid invoice has no old-state equivalent; it is still owed.
    op.execute("UPDATE invoices SET status = 'sent' WHERE status = 'partially_paid'")
    op.drop_constraint("ck_invoices_status", "invoices", type_="check")
    op.create_check_constraint("ck_invoices_status", "invoices", OLD_STATUSES)
    op.drop_constraint("uq_invoices_user_client_request", "invoices", type_="unique")
    op.drop_column("invoices", "client_request_id")
    op.drop_column("invoices", "amount_paid")
