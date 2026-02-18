"""Transaction model — Revenue Engine Layer (Sprint 2).

Records every financial event: sales, refunds, and manual payment logs.
Per ARCHITECTURE.md: method can be stripe, cashapp, paypal, zelle, venmo.
Per STATE_MACHINES.md: Refund creates negative transaction entry.
"""
import uuid

from sqlalchemy import Column, String, Numeric, ForeignKey, CheckConstraint, Index, Boolean
from sqlalchemy.dialects.postgresql import UUID

from app.models.base import Base, TimestampMixin


class Transaction(Base, TimestampMixin):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint(
            "method IN ('stripe', 'cashapp', 'paypal', 'zelle', 'venmo', 'cash', 'other')",
            name="ck_transactions_method",
        ),
        CheckConstraint(
            "status IN ('pending', 'completed', 'failed', 'refunded')",
            name="ck_transactions_status",
        ),
        Index("ix_transactions_user_id", "user_id"),
        Index("ix_transactions_item_id", "item_id"),
        Index("ix_transactions_created_at", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    item_id = Column(
        UUID(as_uuid=True),
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
        UUID(as_uuid=True),
        ForeignKey("transactions.id", ondelete="SET NULL"),
        nullable=True,
    )
