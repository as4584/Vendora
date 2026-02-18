"""Create transactions table — Sprint 2 Revenue Engine.

Revision ID: 002
Revises: 001
Create Date: 2026-02-17
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers
revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "transactions",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("method", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), server_default="completed", nullable=False),
        sa.Column("gross_amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("fee_amount", sa.Numeric(10, 2), server_default="0.00", nullable=False),
        sa.Column("net_amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("external_reference_id", sa.String(255), nullable=True),
        sa.Column("notes", sa.String(500), nullable=True),
        sa.Column("is_refund", sa.Boolean, server_default="false", nullable=False),
        sa.Column("original_transaction_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["item_id"], ["inventory_items.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["original_transaction_id"], ["transactions.id"], ondelete="SET NULL"),
        sa.CheckConstraint(
            "method IN ('stripe', 'cashapp', 'paypal', 'zelle', 'venmo', 'cash', 'other')",
            name="ck_transactions_method",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'completed', 'failed', 'refunded')",
            name="ck_transactions_status",
        ),
    )

    # Indexes
    op.create_index("ix_transactions_user_id", "transactions", ["user_id"])
    op.create_index("ix_transactions_item_id", "transactions", ["item_id"])
    op.create_index("ix_transactions_created_at", "transactions", ["created_at"])

    # Trigger for updated_at
    op.execute("""
        CREATE TRIGGER update_transactions_updated_at
            BEFORE UPDATE ON transactions
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS update_transactions_updated_at ON transactions")
    op.drop_index("ix_transactions_created_at", table_name="transactions")
    op.drop_index("ix_transactions_item_id", table_name="transactions")
    op.drop_index("ix_transactions_user_id", table_name="transactions")
    op.drop_table("transactions")
