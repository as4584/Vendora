"""Inventory item model — Core Engine Layer.

Models:
  InventoryItem           — canonical sellable unit (existing)
  InventoryStockLedger    — immutable audit log of every quantity change
  InventoryExternalLink   — maps a Vendora item to a record in an external system
  InventoryImportJob      — tracks a spreadsheet import preview → commit lifecycle
  InventoryImportRow      — one CSV row with per-row validation and action results
"""
import uuid

import sqlalchemy as sa
from sqlalchemy import (
    Column, String, Numeric, ForeignKey, CheckConstraint,
    Index, Uuid, JSON, text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB  # kept for generic compat

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
            sa.desc("created_at"),
            postgresql_where="deleted_at IS NULL",
        ),
        Index(
            "uq_inventory_user_source_external",
            "user_id",
            "source",
            "external_id",
            unique=True,
            postgresql_where=sa.text("source IS NOT NULL AND external_id IS NOT NULL"),
        ),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(
        Uuid,
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
    custom_attributes = Column(JSONB, nullable=True, server_default=text("'{}'"))
    buy_price = Column(Numeric(10, 2), nullable=True)
    expected_sell_price = Column(Numeric(10, 2), nullable=True)
    actual_sell_price = Column(Numeric(10, 2), nullable=True)
    platform = Column(String(100), nullable=True)
    status = Column(String(20), nullable=False, server_default="in_stock")
    # Photos — stored as base64 data URLs (consistent with profile_picture approach)
    photo_front_url = Column(sa.Text, nullable=True)
    photo_back_url = Column(sa.Text, nullable=True)

    # Quantity — number of units (variants per-size breakdown lives in custom_attributes.variants)
    quantity = Column(sa.Integer, nullable=False, server_default="1")

    # Vendor / sourcing
    vendor_name = Column(String(255), nullable=True)

    # Free-form notes
    notes = Column(sa.Text, nullable=True)

    # Integration tracking — dedup key for synced records
    source = Column(String(50), nullable=True, index=True)       # e.g. "lightspeed", "manual"
    external_id = Column(String(255), nullable=True, index=True) # e.g. Lightspeed itemID


# ─── Stock ledger ────────────────────────────────────────────────────────────

class InventoryStockLedger(Base, TimestampMixin):
    """Immutable audit log of every quantity delta on an inventory item.

    One row per stock event. Never updated — only inserted.
    Used for: sale, refund, import_adjust, manual_adjust, sync.
    """
    __tablename__ = "inventory_stock_ledger"
    __table_args__ = (
        CheckConstraint(
            "event_type IN ('sale','refund','import_adjust','manual_adjust','sync')",
            name="ck_stock_ledger_event_type",
        ),
        Index("ix_stock_ledger_item_id", "inventory_item_id"),
        Index("ix_stock_ledger_user_id", "user_id"),
        Index(
            "ix_stock_ledger_idempotency_key",
            "idempotency_key",
            unique=True,
            postgresql_where=sa.text("idempotency_key IS NOT NULL"),
        ),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    inventory_item_id = Column(
        Uuid, ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False,
    )
    user_id = Column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
    )
    # negative = units removed (sale), positive = units added (refund / import)
    delta_quantity = Column(sa.Integer, nullable=False)
    quantity_after = Column(sa.Integer, nullable=False)
    # sale | refund | import_adjust | manual_adjust | sync
    event_type = Column(String(50), nullable=False)
    # invoice | transaction | import_job | lightspeed | square | clover
    source_type = Column(String(50), nullable=True)
    # UUID or external ID of the triggering record
    source_id = Column(String(255), nullable=True)
    # prevents the same event from writing twice (replay / webhook dedup)
    idempotency_key = Column(String(255), nullable=True)


# ─── External provider links ─────────────────────────────────────────────────

class InventoryExternalLink(Base, TimestampMixin):
    """Maps a Vendora inventory item to a record in an external system.

    Replaces the single (source, external_id) pair on InventoryItem
    for cases where one item has links to multiple providers.
    """
    __tablename__ = "inventory_external_links"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "provider", "external_id",
            name="uq_external_link_user_provider",
        ),
        Index("ix_external_links_item_id", "inventory_item_id"),
        Index("ix_external_links_provider", "provider"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    inventory_item_id = Column(
        Uuid, ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False,
    )
    user_id = Column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
    )
    # lightspeed | square | clover | ebay | spreadsheet
    provider = Column(String(50), nullable=False)
    external_id = Column(String(255), nullable=False)
    external_sku = Column(String(255), nullable=True)
    last_synced_at = Column(sa.DateTime(timezone=True), nullable=True)


# ─── Spreadsheet import ───────────────────────────────────────────────────────

class InventoryImportJob(Base, TimestampMixin):
    """Tracks a spreadsheet import through preview → commit lifecycle."""
    __tablename__ = "inventory_import_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','previewed','committed','failed')",
            name="ck_import_jobs_status",
        ),
        Index("ix_import_jobs_user_id", "user_id"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
    )
    status = Column(String(20), nullable=False, server_default="pending")
    source = Column(String(50), nullable=False, server_default="spreadsheet")
    filename = Column(String(500), nullable=True)
    # {"csv_column_header": "canonical_field_name", ...}
    field_mapping = Column(JSON, nullable=True)
    total_rows = Column(sa.Integer, nullable=False, server_default="0")
    rows_created = Column(sa.Integer, nullable=False, server_default="0")
    rows_updated = Column(sa.Integer, nullable=False, server_default="0")
    rows_skipped = Column(sa.Integer, nullable=False, server_default="0")
    rows_errored = Column(sa.Integer, nullable=False, server_default="0")


class InventoryImportRow(Base, TimestampMixin):
    """One CSV row within an import job with per-row validation and action result."""
    __tablename__ = "inventory_import_rows"
    __table_args__ = (
        Index("ix_import_rows_job_id", "job_id"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    job_id = Column(
        Uuid, ForeignKey("inventory_import_jobs.id", ondelete="CASCADE"), nullable=False,
    )
    row_number = Column(sa.Integer, nullable=False)
    # create | update | skip | error
    action = Column(String(20), nullable=True)
    inventory_item_id = Column(
        Uuid, ForeignKey("inventory_items.id", ondelete="SET NULL"), nullable=True,
    )
    raw_data = Column(JSON, nullable=False)   # original CSV row as dict
    mapped_data = Column(JSON, nullable=True)  # normalized/mapped fields
    error_message = Column(sa.Text, nullable=True)
    # sku | external_id — key used to deduplicate against existing items
    match_key = Column(String(100), nullable=True)
    match_value = Column(String(255), nullable=True)
