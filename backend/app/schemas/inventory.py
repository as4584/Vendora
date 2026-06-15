"""Pydantic schemas for Inventory endpoints."""
from datetime import datetime
from decimal import Decimal
from uuid import UUID
from typing import Any, List, Optional

from pydantic import BaseModel, Field


class SizeVariant(BaseModel):
    """A single size/quantity pair stored inside custom_attributes.variants."""
    size: str
    quantity: int = Field(1, ge=0)


class PhotoUpdate(BaseModel):
    """Payload for PATCH /inventory/{id}/photos."""
    photo_front: str | None = None   # base64 data URL or remote URL
    photo_back: str | None = None    # base64 data URL or remote URL


class InventoryImportRequest(BaseModel):
    """Import inventory from a public/read-only spreadsheet link."""
    url: str = Field(..., max_length=2048)
    dry_run: bool = False
    source_name: str | None = Field(None, max_length=100)


class InventoryImportIssue(BaseModel):
    row: int
    message: str


class InventoryImportResult(BaseModel):
    dry_run: bool
    rows_seen: int
    rows_importable: int
    created: int
    updated: int
    skipped: int
    errors: list[InventoryImportIssue]
    warnings: list[InventoryImportIssue]
    sample_items: list[dict[str, Any]]


VALID_STATUSES = ["in_stock", "listed", "sold", "shipped", "paid", "archived"]


class ItemCreate(BaseModel):
    name: str = Field(..., max_length=255)
    category: str | None = Field(None, max_length=100)
    sku: str | None = Field(None, max_length=100)
    upc: str | None = Field(None, max_length=50)
    size: str | None = Field(None, max_length=50)
    color: str | None = Field(None, max_length=50)
    condition: str | None = Field(None, max_length=50)
    serial_number: str | None = Field(None, max_length=100)
    custom_attributes: dict[str, Any] | None = None
    buy_price: Decimal | None = Field(None, ge=0, decimal_places=2)
    expected_sell_price: Decimal | None = Field(None, ge=0, decimal_places=2)
    actual_sell_price: Decimal | None = Field(None, ge=0, decimal_places=2)
    platform: str | None = Field(None, max_length=100)
    photo_front_url: str | None = None
    photo_back_url: str | None = None
    quantity: int = Field(1, ge=1)
    vendor_name: str | None = Field(None, max_length=255)
    notes: str | None = None


class ItemUpdate(BaseModel):
    name: str | None = Field(None, max_length=255)
    category: str | None = Field(None, max_length=100)
    sku: str | None = Field(None, max_length=100)
    upc: str | None = Field(None, max_length=50)
    size: str | None = Field(None, max_length=50)
    color: str | None = Field(None, max_length=50)
    condition: str | None = Field(None, max_length=50)
    serial_number: str | None = Field(None, max_length=100)
    custom_attributes: dict[str, Any] | None = None
    buy_price: Decimal | None = Field(None, ge=0, decimal_places=2)
    expected_sell_price: Decimal | None = Field(None, ge=0, decimal_places=2)
    actual_sell_price: Decimal | None = Field(None, ge=0, decimal_places=2)
    platform: str | None = Field(None, max_length=100)
    photo_front_url: str | None = None
    photo_back_url: str | None = None
    quantity: int | None = Field(None, ge=0)
    vendor_name: str | None = Field(None, max_length=255)
    notes: str | None = None


class StatusUpdate(BaseModel):
    status: str = Field(..., description="Target status for state transition")


class ItemResponse(BaseModel):
    id: UUID
    user_id: UUID
    name: str
    category: str | None
    sku: str | None
    upc: str | None
    size: str | None
    color: str | None
    condition: str | None
    serial_number: str | None
    custom_attributes: dict[str, Any] | None
    buy_price: Decimal | None
    expected_sell_price: Decimal | None
    actual_sell_price: Decimal | None
    platform: str | None
    status: str
    photo_front_url: str | None = None
    photo_back_url: str | None = None
    quantity: int = 1
    vendor_name: str | None = None
    notes: str | None = None
    source: str | None = None
    external_id: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PaginatedItems(BaseModel):
    items: list[ItemResponse]
    total: int
    page: int
    per_page: int
    pages: int


class InventoryActivityEntry(BaseModel):
    """One stock/activity event for an inventory item."""

    id: UUID
    inventory_item_id: UUID
    delta_quantity: int
    quantity_after: int
    event_type: str
    source_type: str | None = None
    source_id: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ─── Import schemas ────────────────────────────────────────────────────

class ImportRowResult(BaseModel):
    """Preview or commit result for a single CSV row."""
    row_number: int
    action: Optional[str]           # create | update | skip | error
    inventory_item_id: Optional[UUID] = None
    mapped_data: Optional[dict[str, Any]] = None
    match_key: Optional[str] = None
    match_value: Optional[str] = None
    error_message: Optional[str] = None


class ImportJobResponse(BaseModel):
    """Status and summary for a spreadsheet import job."""
    id: UUID
    status: str                     # pending | previewed | committed | failed
    filename: Optional[str] = None
    field_mapping: Optional[dict[str, Any]] = None
    total_rows: int
    rows_created: int
    rows_updated: int
    rows_skipped: int
    rows_errored: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ImportPreviewResponse(BaseModel):
    """Response for POST /inventory/imports/preview."""
    job_id: UUID
    status: str
    filename: Optional[str] = None
    detected_mapping: dict[str, str]  # csv_col → canonical_field
    rows: list[ImportRowResult]
    total_rows: int
    rows_to_create: int
    rows_to_update: int
    rows_to_skip: int
    rows_errored: int


class ImportCommitResponse(BaseModel):
    """Response for POST /inventory/imports/{job_id}/commit."""
    job_id: UUID
    status: str
    rows_created: int
    rows_updated: int
    rows_skipped: int
    rows_errored: int
