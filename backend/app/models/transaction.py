"""Transaction model — Revenue Engine Layer (Sprint 2).

Records every financial event: sales, refunds, and manual payment logs.
Per ARCHITECTURE.md: method can be stripe, cashapp, paypal, zelle, venmo.
Per STATE_MACHINES.md: Refund creates negative transaction entry.
"""
import uuid

import sqlalchemy as sa
from sqlalchemy import Column, String, Numeric, ForeignKey, CheckConstraint, Index, Boolean, Uuid
# from sqlalchemy.dialects.postgresql import UUID

from app.models.base import Base, TimestampMixin


class Transaction(Base, TimestampMixin):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint(
            "method IN ('stripe', 'cashapp', 'paypal', 'zelle', 'venmo', 'cash', 'card', 'other')",
            name="ck_transactions_method",
        ),
        CheckConstraint(
            "status IN ('pending', 'completed', 'failed', 'refunded')",
            name="ck_transactions_status",
        ),
        Index("ix_transactions_user_id", "user_id"),
        Index("ix_transactions_item_id", "item_id"),
        Index("ix_transactions_created_at", "created_at"),
        Index("ix_transactions_invoice_id", "invoice_id"),
        Index("ix_transactions_order_id", "order_id"),
        Index(
            "uq_transactions_user_source_external",
            "user_id",
            "source",
            "external_reference_id",
            unique=True,
            postgresql_where=sa.text("source IS NOT NULL AND external_reference_id IS NOT NULL"),
        ),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(
        Uuid,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    item_id = Column(
        Uuid,
        ForeignKey("inventory_items.id", ondelete="SET NULL"),
        nullable=True,
    )
    method = Column(String(20), nullable=False)
    status = Column(String(20), nullable=False, server_default="completed")
    gross_amount = Column(Numeric(10, 2), nullable=False)
    fee_amount = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    net_amount = Column(Numeric(10, 2), nullable=False)
    external_reference_id = Column(String(255), nullable=True)
    notes = Column(String(500), nullable=True)
    is_refund = Column(Boolean, nullable=False, server_default="false")
    original_transaction_id = Column(
        Uuid,
        ForeignKey("transactions.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Invoice linkage — set when transaction was created by process_invoice_payment
    invoice_id = Column(
        Uuid,
        ForeignKey("invoices.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Number of inventory units this transaction covers
    quantity = Column(sa.Integer, nullable=False, server_default="1")
    # Shared by every line of one multi-item sale (POST /transactions/order).
    order_id = Column(Uuid, nullable=True)
    # Integration tracking
    source = Column(String(50), nullable=True, index=True)  # e.g. "lightspeed", "manual"
    # Cost of goods for this line, frozen at the moment of sale (unit buy price
    # x quantity). Refunds carry the negative of the original's cost, because
    # the unit goes back into stock. NULL = cost unknown (item had no buy price).
    cost_amount = Column(Numeric(10, 2), nullable=True)


@sa.event.listens_for(Transaction, "before_insert")
def _freeze_cost(mapper, connection, target):  # noqa: ARG001 - SQLAlchemy signature
    """Every way a sale is created (POS, order, invoice, integrations) gets its cost."""
    if target.cost_amount is not None:
        return
    if target.is_refund and target.original_transaction_id is not None:
        original_cost = connection.execute(
            sa.select(Transaction.__table__.c.cost_amount).where(
                Transaction.__table__.c.id == target.original_transaction_id
            )
        ).scalar()
        if original_cost is not None:
            target.cost_amount = -original_cost
        return
    if target.item_id is None or target.is_refund:
        return
    from app.models.inventory import InventoryItem

    buy_price = connection.execute(
        sa.select(InventoryItem.__table__.c.buy_price).where(InventoryItem.__table__.c.id == target.item_id)
    ).scalar()
    if buy_price is not None:
        target.cost_amount = buy_price * (target.quantity or 1)
