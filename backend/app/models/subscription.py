"""Subscription model — Sprint 3 subscription billing.

Per ARCHITECTURE.md:
    tier: free | pro
    is_partner: boolean
    status: active, past_due, cancelled
"""
import uuid

from sqlalchemy import Column, String, Numeric, Boolean, ForeignKey, CheckConstraint, Index, DateTime
from sqlalchemy.dialects.postgresql import UUID

from app.models.base import Base, TimestampMixin


class Subscription(Base, TimestampMixin):
    __tablename__ = "subscriptions"
    __table_args__ = (
        CheckConstraint(
            "tier IN ('free', 'pro')",
            name="ck_subscriptions_tier",
        ),
        CheckConstraint(
            "status IN ('active', 'past_due', 'cancelled')",
            name="ck_subscriptions_status",
        ),
        Index("ix_subscriptions_user_id", "user_id"),
        Index("ix_subscriptions_stripe_id", "stripe_subscription_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    stripe_subscription_id = Column(String(255), nullable=True, unique=True)
    tier = Column(String(20), nullable=False, server_default="free")
    is_partner = Column(Boolean, nullable=False, server_default="false")
    price_monthly = Column(Numeric(10, 2), nullable=False, server_default="0.00")
    status = Column(String(20), nullable=False, server_default="active")
    current_period_end = Column(DateTime(timezone=True), nullable=True)


class WebhookEvent(Base, TimestampMixin):
    """Tracks processed Stripe webhook events for idempotency / deduplication."""
    __tablename__ = "webhook_events"
    __table_args__ = (
        Index("ix_webhook_events_event_id", "event_id", unique=True),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id = Column(String(255), nullable=False, unique=True)
    event_type = Column(String(100), nullable=False)
    processed = Column(Boolean, nullable=False, server_default="true")
