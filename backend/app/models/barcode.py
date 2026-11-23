"""Seller-controlled barcode handling.

Stores print their own barcodes (shelf tags, SKU stickers, price-embedded
codes), so a scan can't rely on manufacturer UPCs alone:

* ``BarcodeRule`` - "codes that look like this mean that": match a prefix,
  suffix or length, strip/slice the code, then look it up as a SKU, UPC or
  linked barcode.
* ``ItemBarcode`` - "this exact code is this item": any number of extra codes
  linked to one inventory item, taught once from an unknown scan.
"""
import uuid

from sqlalchemy import Boolean, CheckConstraint, Column, ForeignKey, Index, Integer, String, UniqueConstraint, Uuid

from app.models.base import Base, TimestampMixin

LOOKUP_FIELDS = ("auto", "sku", "upc", "linked")


class BarcodeRule(Base, TimestampMixin):
    __tablename__ = "barcode_rules"
    __table_args__ = (
        CheckConstraint(
            "lookup_field IN ('auto', 'sku', 'upc', 'linked')", name="ck_barcode_rules_lookup_field"
        ),
        Index("ix_barcode_rules_user_position", "user_id", "position"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(80), nullable=False)
    prefix = Column(String(32), nullable=True)
    suffix = Column(String(32), nullable=True)
    min_length = Column(Integer, nullable=True)
    max_length = Column(Integer, nullable=True)
    strip_prefix = Column(Boolean, nullable=False, default=True, server_default="true")
    strip_suffix = Column(Boolean, nullable=False, default=True, server_default="true")
    slice_start = Column(Integer, nullable=True)   # 1-based, applied after stripping
    slice_length = Column(Integer, nullable=True)
    lookup_field = Column(String(10), nullable=False, default="auto", server_default="auto")
    position = Column(Integer, nullable=False, default=0, server_default="0")
    enabled = Column(Boolean, nullable=False, default=True, server_default="true")


class ItemBarcode(Base, TimestampMixin):
    __tablename__ = "item_barcodes"
    __table_args__ = (
        UniqueConstraint("user_id", "code", name="uq_item_barcodes_user_code"),
        Index("ix_item_barcodes_item", "inventory_item_id"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    inventory_item_id = Column(Uuid, ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False)
    code = Column(String(64), nullable=False)
