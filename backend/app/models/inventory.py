"""Inventory item model — Core Engine Layer."""
import uuid

from sqlalchemy import Column, String, Numeric, ForeignKey, CheckConstraint, Index
from sqlalchemy.dialects.postgresql import UUID, JSONB

from app.models.base import Base, TimestampMixin, SoftDeleteMixin


class InventoryItem(Base, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "inventory_items"
    __table_args__ = (
        CheckConstraint(
            "status IN ('in_stock', 'listed', 'sold', 'shipped', 'paid', 'archived')",
            name="ck_inventory_items_status",
        ),
        Index("ix_inventory_items_user_id", "user_id"),
        Index("ix_inventory_items_status", "status"),
        Index("ix_inventory_items_category", "category"),
        Index("ix_inventory_items_created_at", "created_at"),
        # Composite partial index for stable per-user pagination + tier count
        Index(
            "ix_inventory_user_created",
            "user_id",
            "created_at",
            postgresql_where="deleted_at IS NULL",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    name = Column(String(255), nullable=False)
    category = Column(String(100), nullable=True)
    sku = Column(String(100), nullable=True)
    upc = Column(String(50), nullable=True)
    size = Column(String(50), nullable=True)
    color = Column(String(50), nullable=True)
    condition = Column(String(50), nullable=True)
    serial_number = Column(String(100), nullable=True)
    custom_attributes = Column(JSONB, nullable=True, server_default="{}")
    buy_price = Column(Numeric(10, 2), nullable=True)
    expected_sell_price = Column(Numeric(10, 2), nullable=True)
    actual_sell_price = Column(Numeric(10, 2), nullable=True)
    platform = Column(String(100), nullable=True)
    status = Column(String(20), nullable=False, server_default="in_stock")
