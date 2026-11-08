"""Customers: a record per buyer, linked from invoices and checkout sales.

Backfills one customer per distinct buyer on existing invoices (matched by
email, else by name) and links those invoices to it.

Revision ID: 032
Revises: 031

"""
from alembic import op
import sqlalchemy as sa

revision = "032"
down_revision = "031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "customers",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("email", sa.String(255), nullable=True),
        sa.Column("phone", sa.String(50), nullable=True),
        sa.Column("address", sa.String(500), nullable=True),
        sa.Column("tax_exempt", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("notes", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_customers_user_id", "customers", ["user_id"])
    op.create_index("ix_customers_user_email", "customers", ["user_id", "email"])
    op.create_index("ix_customers_user_phone", "customers", ["user_id", "phone"])

    op.add_column("invoices", sa.Column("customer_phone", sa.String(50), nullable=True))
    op.add_column(
        "invoices",
        sa.Column("customer_id", sa.Uuid(), sa.ForeignKey("customers.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_invoices_customer_id", "invoices", ["customer_id"])
    op.add_column(
        "transactions",
        sa.Column("customer_id", sa.Uuid(), sa.ForeignKey("customers.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_transactions_customer_id", "transactions", ["customer_id"])

    # Backfill: one customer per (seller, email-or-name) seen on an invoice.
    op.execute(
        """
        INSERT INTO customers (id, user_id, name, email, tax_exempt, created_at, updated_at)
        SELECT gen_random_uuid(), user_id, MAX(customer_name), MAX(NULLIF(LOWER(TRIM(customer_email)), '')),
               false, MIN(created_at), MAX(created_at)
        FROM invoices
        WHERE TRIM(customer_name) <> ''
        GROUP BY user_id, COALESCE(NULLIF(LOWER(TRIM(customer_email)), ''), LOWER(TRIM(customer_name)))
        """
    )
    op.execute(
        """
        UPDATE invoices i SET customer_id = c.id
        FROM customers c
        WHERE c.user_id = i.user_id AND (
            (NULLIF(TRIM(i.customer_email), '') IS NOT NULL AND c.email = LOWER(TRIM(i.customer_email)))
            OR (NULLIF(TRIM(i.customer_email), '') IS NULL AND c.email IS NULL
                AND LOWER(TRIM(c.name)) = LOWER(TRIM(i.customer_name)))
        )
        """
    )


def downgrade() -> None:
    op.drop_index("ix_transactions_customer_id", table_name="transactions")
    op.drop_column("transactions", "customer_id")
    op.drop_index("ix_invoices_customer_id", table_name="invoices")
    op.drop_column("invoices", "customer_id")
    op.drop_column("invoices", "customer_phone")
    op.drop_index("ix_customers_user_phone", table_name="customers")
    op.drop_index("ix_customers_user_email", table_name="customers")
    op.drop_index("ix_customers_user_id", table_name="customers")
    op.drop_table("customers")
