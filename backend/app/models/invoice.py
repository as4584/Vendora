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
from decimal import Decimal

from sqlalchemy import Column, String, Numeric, Integer, ForeignKey, CheckConstraint, Index, UniqueConstraint, Uuid
# from sqlalchemy.dialects.postgresql import UUID

from app.models.base import Base, TimestampMixin
from app.models import customer as _customer  # noqa: F401  (registers the customers FK target)


class Invoice(Base, TimestampMixin):
    __tablename__ = "invoices"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'sent', 'partially_paid', 'paid', 'cancelled')",
            name="ck_invoices_status",
        ),
        Index("ix_invoices_user_id", "user_id"),
        Index("ix_invoices_status", "status"),
        Index("ix_invoices_created_at", "created_at"),
        Index("ix_invoices_customer_id", "customer_id"),
        UniqueConstraint("user_id", "number", name="uq_invoices_user_number"),
        # Offline replay key: the same queued create never makes two invoices.
        UniqueConstraint("user_id", "client_request_id", name="uq_invoices_user_client_request"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(
        Uuid,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Per-user sequence, assigned once at creation and never reused or changed.
    number = Column(Integer, nullable=False)
    customer_name = Column(String(255), nullable=False)
    customer_email = Column(String(255), nullable=True)
    customer_phone = Column(String(50), nullable=True)
    customer_id = Column(Uuid, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(20), nullable=False, server_default="draft")
    subtotal = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    tax = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    shipping = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    discount = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    total = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    stripe_payment_intent_id = Column(String(255), nullable=True)
    notes = Column(String(1000), nullable=True)
    # Sum of InvoicePayment.amount; balance_due = total - amount_paid.
    amount_paid = Column(Numeric(10, 2), nullable=False, server_default="0.00", default=Decimal("0.00"))
    client_request_id = Column(String(100), nullable=True)

    @property
    def balance_due(self):
        return max(Decimal(str(self.total or 0)) - Decimal(str(self.amount_paid or 0)), Decimal("0.00"))

    @property
    def invoice_number(self) -> str:
        return f"INV{self.number:04d}" if self.number else ""


class InvoiceItem(Base):
    __tablename__ = "invoice_items"

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    invoice_id = Column(
        Uuid,
        ForeignKey("invoices.id", ondelete="CASCADE"),
        nullable=False,
    )
    inventory_item_id = Column(
        Uuid,
        ForeignKey("inventory_items.id", ondelete="SET NULL"),
        nullable=True,
    )
    size_label = Column(String(50), nullable=True)
    description = Column(String(500), nullable=False)
    quantity = Column(Integer, nullable=False, server_default="1")
    unit_price = Column(Numeric(10, 2), nullable=False)
    line_total = Column(Numeric(10, 2), nullable=False)
    # Cost of goods for the whole line, frozen at the first payment so later
    # buy-price edits never change the profit of an already-started sale.
    cost_amount = Column(Numeric(10, 2), nullable=True)


PAYMENT_METHODS = ("cash", "card", "zelle", "venmo", "cashapp", "paypal", "stripe", "other")


class InvoicePayment(Base, TimestampMixin):
    __tablename__ = "invoice_payments"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_invoice_payments_amount_positive"),
        CheckConstraint(
            "method IN ('cash', 'card', 'zelle', 'venmo', 'cashapp', 'paypal', 'stripe', 'other')",
            name="ck_invoice_payments_method",
        ),
        Index("ix_invoice_payments_invoice_id", "invoice_id"),
        UniqueConstraint("user_id", "client_request_id", name="uq_invoice_payments_user_client_request"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    invoice_id = Column(Uuid, ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    amount = Column(Numeric(10, 2), nullable=False)
    method = Column(String(20), nullable=False)
    note = Column(String(500), nullable=True)
    client_request_id = Column(String(100), nullable=True)
