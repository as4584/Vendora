"""First-party product analytics: one row per funnel event. No third-party SDK."""

import uuid

from sqlalchemy import JSON, Column, DateTime, ForeignKey, Index, String, Uuid, func

from app.models.base import Base


class AppEvent(Base):
    __tablename__ = "app_events"
    __table_args__ = (Index("ix_app_events_name_created", "name", "created_at"),)

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name = Column(String(64), nullable=False)
    props = Column(JSON, nullable=True)
    created_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
