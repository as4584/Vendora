"""Transaction Pydantic schemas — request/response validation."""
from datetime import datetime
from decimal import Decimal
from uuid import UUID
from typing import Optional, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


PAYMENT_METHODS = Literal["stripe", "cashapp", "paypal", "zelle", "venmo", "cash", "other"]
TRANSACTION_STATUSES = Literal["pending", "completed", "failed", "refunded"]


class TransactionCreate(BaseModel):
    """Create a new transaction (manual payment log or Quick Sale)."""
    item_id: Optional[UUID] = None
    method: PAYMENT_METHODS
    gross_amount: Decimal = Field(ge=0, max_digits=10, decimal_places=2)
    fee_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=10, decimal_places=2)
    quantity: int = Field(default=1, ge=1, description="Number of units sold (for inventory-backed items)")
    external_reference_id: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=500)
    # Set by the app's offline outbox so a replayed sale is recorded only once.
    client_request_id: Optional[str] = Field(None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")

    @model_validator(mode="after")
    def check_amounts(self):
        if self.fee_amount > self.gross_amount:
            raise ValueError("Fee cannot exceed gross amount")
        return self


class RefundCreate(BaseModel):
    """Create a refund for an existing transaction."""
    reason: Optional[str] = Field(None, max_length=500)


class TransactionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    item_id: Optional[UUID] = None
    invoice_id: Optional[UUID] = None
    method: str
    status: str
    gross_amount: Decimal
    fee_amount: Decimal
    net_amount: Decimal
    quantity: int = 1
    external_reference_id: Optional[str] = None
    notes: Optional[str] = None
    is_refund: bool
    original_transaction_id: Optional[UUID] = None
    order_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime


class SaleOrderLine(BaseModel):
    item_id: UUID
    quantity: int = Field(default=1, ge=1)
    # Price actually agreed per unit (haggled), not necessarily the list price.
    unit_price: Decimal = Field(ge=0, max_digits=10, decimal_places=2)


class SaleOrderCreate(BaseModel):
    """One checkout with one or more items, recorded all-or-nothing."""
    lines: list[SaleOrderLine] = Field(min_length=1, max_length=100)
    method: PAYMENT_METHODS
    fee_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=10, decimal_places=2)
    notes: Optional[str] = Field(None, max_length=500)
    client_request_id: Optional[str] = Field(None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")

    @model_validator(mode="after")
    def check_amounts(self):
        gross = sum(line.unit_price * line.quantity for line in self.lines)
        if self.fee_amount > gross:
            raise ValueError("Fee cannot exceed the order total")
        return self


class SaleOrderResponse(BaseModel):
    order_id: UUID
    gross_amount: Decimal
    fee_amount: Decimal
    net_amount: Decimal
    transactions: list[TransactionResponse]

class TransactionListResponse(BaseModel):
    items: list[TransactionResponse]
    total: int
    page: int
    per_page: int
    pages: int
