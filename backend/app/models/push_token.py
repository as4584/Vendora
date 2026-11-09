"""Expo push tokens, one row per device. Used only for eBay sale alerts."""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, Uuid, func

from app.models.base import Base


class PushToken(Base):
    __tablename__ = "push_tokens"

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token = Column(String(255), nullable=False, unique=True)
    platform = Column(String(16), nullable=True)
    created_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
