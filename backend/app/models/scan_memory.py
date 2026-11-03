"""Per-account barcode memory: what a seller confirmed a barcode to be.

Filled only by the seller's own saves (no outside lookups). A row's fields are
the last values the seller confirmed for that barcode, so a correction always
wins next time.
"""
import uuid

from sqlalchemy import Column, ForeignKey, Index, Integer, JSON, String, UniqueConstraint, Uuid

from app.models.base import Base, TimestampMixin


class ScanMemory(Base, TimestampMixin):
    __tablename__ = "scan_memory"
    __table_args__ = (
        UniqueConstraint("user_id", "barcode", name="uq_scan_memory_user_barcode"),
        Index("ix_scan_memory_user_style", "user_id", "style_code"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    barcode = Column(String(64), nullable=False)
    style_code = Column(String(64), nullable=True)
    fields = Column(JSON, nullable=False, default=dict)
    times_seen = Column(Integer, nullable=False, default=1, server_default="1")
