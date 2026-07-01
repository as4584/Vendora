"""Invoice Pydantic schemas — request/response validation."""
from datetime import datetime
from decimal import Decimal
from uuid import UUID
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class InvoiceItemCreate(BaseModel):
    inventory_item_id: Optional[UUID] = None
    size_label: Optional[str] = Field(None, max_length=50)
    description: str = Field(max_length=500)
    quantity: int = Field(default=1, ge=1)
    unit_price: Decimal = Field(ge=0, max_digits=10, decimal_places=2)


class InvoiceItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    invoice_id: UUID
    inventory_item_id: Optional[UUID] = None
    size_label: Optional[str] = None
    description: str
    quantity: int
    unit_price: Decimal
    line_total: Decimal

class InvoiceCreate(BaseModel):
    customer_name: str = Field(max_length=255)
    customer_email: Optional[str] = Field(None, max_length=255)
    items: list[InvoiceItemCreate] = Field(min_length=1)
    tax: Decimal = Field(default=Decimal("0.00"), ge=0)
    shipping: Decimal = Field(default=Decimal("0.00"), ge=0)
    discount: Decimal = Field(default=Decimal("0.00"), ge=0)
    notes: Optional[str] = Field(None, max_length=1000)


class InvoiceUpdate(BaseModel):
    customer_name: str = Field(max_length=255)
    customer_email: Optional[str] = Field(None, max_length=255)
    items: list[InvoiceItemCreate] = Field(min_length=1)
    tax: Decimal = Field(default=Decimal("0.00"), ge=0)
    shipping: Decimal = Field(default=Decimal("0.00"), ge=0)
    discount: Decimal = Field(default=Decimal("0.00"), ge=0)
    notes: Optional[str] = Field(None, max_length=1000)


class InvoiceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    customer_name: str
    customer_email: Optional[str] = None
    status: str
    subtotal: Decimal
    tax: Decimal
    shipping: Decimal
    discount: Decimal
    total: Decimal
    stripe_payment_intent_id: Optional[str] = None
    notes: Optional[str] = None
    items: list[InvoiceItemResponse] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

class InvoiceListResponse(BaseModel):
    items: list[InvoiceResponse]
    total: int
    page: int
    per_page: int
    pages: int


class InvoiceStatusUpdate(BaseModel):
    status: str
