"""Pydantic schemas for Inventory endpoints."""
from datetime import datetime
from decimal import Decimal
from uuid import UUID
from typing import Any

from pydantic import BaseModel, Field


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
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PaginatedItems(BaseModel):
    items: list[ItemResponse]
    total: int
    page: int
    per_page: int
    pages: int
