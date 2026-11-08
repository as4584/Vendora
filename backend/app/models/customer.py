"""Customer model: the people a seller sells to.

Customers are derived from invoices and checkouts: creating an invoice for a
new name/email/phone makes (or reuses) a customer, and a checkout can be
tagged with one. Purchase history and totals are computed from the invoices
and sale transactions that point at the customer, so nothing is duplicated.
"""
import uuid

from sqlalchemy import Boolean, Column, ForeignKey, Index, String, Uuid

from app.models.base import Base, TimestampMixin


class Customer(Base, TimestampMixin):
    __tablename__ = "customers"
    __table_args__ = (
        Index("ix_customers_user_id", "user_id"),
        Index("ix_customers_user_email", "user_id", "email"),
        Index("ix_customers_user_phone", "user_id", "phone"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    # Stored lower-cased so matching is case-insensitive.
    email = Column(String(255), nullable=True)
    # Stored as digits only (plus a leading "+" when given) so matching ignores formatting.
    phone = Column(String(50), nullable=True)
    address = Column(String(500), nullable=True)
    tax_exempt = Column(Boolean, nullable=False, default=False, server_default="false")
    notes = Column(String(500), nullable=True)
