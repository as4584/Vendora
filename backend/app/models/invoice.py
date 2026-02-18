"""Invoice + InvoiceItem models — Sprint 3 Automated Money Layer.

Per ARCHITECTURE.md:
    invoices: draft → sent → paid → (locked)  /  sent → cancelled
    invoice_items: line items linked to inventory

Per STATE_MACHINES.md:
    Paid invoices cannot be edited.
    Cancelled invoices cannot be paid.
    Stripe webhook triggers paid transition.
"""
import uuid

from sqlalchemy import Column, String, Numeric, Integer, ForeignKey, CheckConstraint, Index
from sqlalchemy.dialects.postgresql import UUID

from app.models.base import Base, TimestampMixin


class Invoice(Base, TimestampMixin):
    __tablename__ = "invoices"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'sent', 'paid', 'cancelled')",
            name="ck_invoices_status",
        ),
        Index("ix_invoices_user_id", "user_id"),
        Index("ix_invoices_status", "status"),
        Index("ix_invoices_created_at", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    customer_name = Column(String(255), nullable=False)
    customer_email = Column(String(255), nullable=True)
    status = Column(String(20), nullable=False, server_default="draft")
    subtotal = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    tax = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    shipping = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    discount = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    total = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    stripe_payment_intent_id = Column(String(255), nullable=True)
    notes = Column(String(1000), nullable=True)


class InvoiceItem(Base):
    __tablename__ = "invoice_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    invoice_id = Column(
        UUID(as_uuid=True),
        ForeignKey("invoices.id", ondelete="CASCADE"),
        nullable=False,
    )
    inventory_item_id = Column(
        UUID(as_uuid=True),
        ForeignKey("inventory_items.id", ondelete="SET NULL"),
        nullable=True,
    )
    description = Column(String(500), nullable=False)
    quantity = Column(Integer, nullable=False, server_default="1")
    unit_price = Column(Numeric(10, 2), nullable=False)
    line_total = Column(Numeric(10, 2), nullable=False)
