"""Support requests submitted from the Vendora app."""
import uuid

from sqlalchemy import Column, ForeignKey, Index, String, Text, Uuid

from app.models.base import Base, TimestampMixin


class SupportRequest(Base, TimestampMixin):
    __tablename__ = "support_requests"
    __table_args__ = (Index("ix_support_requests_user_id", "user_id"),)

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    subject = Column(String(160), nullable=False)
    message = Column(Text, nullable=False)
    priority = Column(String(20), nullable=False, server_default="standard")
    status = Column(String(20), nullable=False, server_default="open")
