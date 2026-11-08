"""Customer schemas."""
from datetime import datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class CustomerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    email: Optional[str] = Field(None, max_length=255)
    phone: Optional[str] = Field(None, max_length=50)
    address: Optional[str] = Field(None, max_length=500)
    tax_exempt: bool = False
    notes: Optional[str] = Field(None, max_length=500)


class CustomerUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    email: Optional[str] = Field(None, max_length=255)
    phone: Optional[str] = Field(None, max_length=50)
    address: Optional[str] = Field(None, max_length=500)
    tax_exempt: Optional[bool] = None
    notes: Optional[str] = Field(None, max_length=500)


class CustomerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    tax_exempt: bool = False
    notes: Optional[str] = None
    order_count: int = 0
    total_spent: Decimal = Decimal("0.00")
    last_purchase_at: Optional[datetime] = None
    created_at: datetime


class CustomerListResponse(BaseModel):
    items: list[CustomerResponse]
    total: int


class CustomerInvoiceSummary(BaseModel):
    id: UUID
    invoice_number: str
    status: str
    total: Decimal
    amount_paid: Decimal
    created_at: datetime


class CustomerOrderSummary(BaseModel):
    order_id: Optional[UUID] = None
    transaction_id: UUID
    total: Decimal
    item_count: int
    refunded: bool = False
    created_at: datetime


class CustomerDetailResponse(CustomerResponse):
    invoices: list[CustomerInvoiceSummary] = []
    orders: list[CustomerOrderSummary] = []
