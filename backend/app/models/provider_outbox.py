"""Durable provider outbox.

A row is written in the SAME database transaction as the local change that
requires a remote side effect (e.g. "stock for this size hit 0, remove the
StockX ask"). A worker processes pending rows after commit, with retries and
backoff. ``idempotency_key`` is unique, so enqueueing the same job twice is a
no-op and replays are safe.

Generic by design (``provider`` column) so other providers (eBay) can share it.
"""
import uuid

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Index, Integer, String, Uuid

from app.models.base import Base, TimestampMixin

OUTBOX_STATUSES = ("pending", "processing", "done", "failed")


class ProviderOutbox(Base, TimestampMixin):
    __tablename__ = "provider_outbox"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','processing','done','failed')",
            name="ck_provider_outbox_status",
        ),
        Index("uq_provider_outbox_idempotency_key", "idempotency_key", unique=True),
        Index("ix_provider_outbox_user_id", "user_id"),
        Index("ix_provider_outbox_status_next", "status", "next_attempt_at"),
        Index("ix_provider_outbox_item", "inventory_item_id"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    provider = Column(String(50), nullable=False)
    action = Column(String(50), nullable=False)
    payload = Column(sa.JSON, nullable=False)
    idempotency_key = Column(String(255), nullable=False)
    status = Column(String(20), nullable=False, server_default="pending", default="pending")
    attempts = Column(Integer, nullable=False, server_default="0", default=0)
    max_attempts = Column(Integer, nullable=False, server_default="6", default=6)
    next_attempt_at = Column(DateTime(timezone=True), nullable=True)
    last_error = Column(sa.Text, nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    # Item the job concerns (eBay quantity pushes coalesce per item). Nullable:
    # StockX jobs reference their listing in the payload.
    inventory_item_id = Column(Uuid, ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=True)
