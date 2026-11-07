"""Invoice Pydantic schemas — request/response validation."""
from datetime import datetime
from decimal import Decimal
from uuid import UUID
from typing import Literal, Optional

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
    customer_phone: Optional[str] = Field(None, max_length=50)
    # Pick an existing customer; otherwise one is matched/created from the fields above.
    customer_id: Optional[UUID] = None
    items: list[InvoiceItemCreate] = Field(min_length=1)
    tax: Decimal = Field(default=Decimal("0.00"), ge=0)
    shipping: Decimal = Field(default=Decimal("0.00"), ge=0)
    discount: Decimal = Field(default=Decimal("0.00"), ge=0)
    notes: Optional[str] = Field(None, max_length=1000)
    # Set by the offline outbox; a replay returns the invoice it already made.
    client_request_id: Optional[str] = Field(None, min_length=8, max_length=100)


class InvoiceUpdate(BaseModel):
    customer_name: str = Field(max_length=255)
    customer_email: Optional[str] = Field(None, max_length=255)
    customer_phone: Optional[str] = Field(None, max_length=50)
    customer_id: Optional[UUID] = None
    customer_phone: Optional[str] = Field(None, max_length=50)
    # Pick an existing customer; otherwise one is matched/created from the fields above.
    customer_id: Optional[UUID] = None
    items: list[InvoiceItemCreate] = Field(min_length=1)
    tax: Decimal = Field(default=Decimal("0.00"), ge=0)
    shipping: Decimal = Field(default=Decimal("0.00"), ge=0)
    discount: Decimal = Field(default=Decimal("0.00"), ge=0)
    notes: Optional[str] = Field(None, max_length=1000)


class InvoiceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    number: int
    invoice_number: str
    customer_name: str
    customer_email: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_id: Optional[UUID] = None
    status: str
    subtotal: Decimal
    tax: Decimal
    shipping: Decimal
    discount: Decimal
    total: Decimal
    stripe_payment_intent_id: Optional[str] = None
    notes: Optional[str] = None
    items: list[InvoiceItemResponse] = Field(default_factory=list)
    amount_paid: Decimal = Decimal("0.00")
    balance_due: Decimal = Decimal("0.00")
    payments: list["InvoicePaymentResponse"] = Field(default_factory=list)
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


PaymentMethod = Literal["cash", "card", "zelle", "venmo", "cashapp", "paypal", "stripe", "other"]


class InvoicePaymentCreate(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=10, decimal_places=2)
    method: PaymentMethod
    note: Optional[str] = Field(None, max_length=500)
    client_request_id: Optional[str] = Field(None, min_length=8, max_length=100)


class InvoicePaymentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    invoice_id: UUID
    amount: Decimal
    method: str
    note: Optional[str] = None
    created_at: datetime


InvoiceResponse.model_rebuild()
