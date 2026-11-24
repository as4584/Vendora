"""Trade request/response schemas."""
from datetime import datetime
from decimal import Decimal
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

CASH_METHODS = Literal["cash", "card", "venmo", "cashapp", "paypal", "zelle", "other"]
Money = Field(ge=0, max_digits=10, decimal_places=2)


class TradeGive(BaseModel):
    """A pair I hand over, at the value we agreed for it."""
    item_id: UUID
    quantity: int = Field(default=1, ge=1, le=100)
    size: Optional[str] = Field(None, min_length=1, max_length=50)
    value: Decimal = Money  # per unit


class TradeGet(BaseModel):
    """A pair I receive. `value` is its agreed trade value (usually market)."""
    name: str = Field(min_length=1, max_length=255)
    size: Optional[str] = Field(None, max_length=50)
    upc: Optional[str] = Field(None, max_length=50)
    sku: Optional[str] = Field(None, max_length=100)
    category: Optional[str] = Field(None, max_length=100)
    condition: Optional[str] = Field(None, max_length=50)
    value: Decimal = Money
    # What I'll ask for it; defaults to the trade value.
    list_price: Optional[Decimal] = Field(None, ge=0, max_digits=10, decimal_places=2)


class TradeCreate(BaseModel):
    give: list[TradeGive] = Field(default_factory=list, max_length=50)
    get: list[TradeGet] = Field(default_factory=list, max_length=50)
    # Positive: they pay me. Negative: I pay them.
    cash_amount: Decimal = Field(default=Decimal("0.00"), max_digits=10, decimal_places=2)
    cash_method: CASH_METHODS = "cash"
    notes: Optional[str] = Field(None, max_length=500)
    customer_id: Optional[UUID] = None
    client_request_id: Optional[str] = Field(None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")

    @model_validator(mode="after")
    def _not_empty(self):
        if not self.give and not self.get:
            raise ValueError("A trade needs at least one pair given or received")
        return self


class TradeResponse(BaseModel):
    id: UUID
    order_id: UUID
    value_out: Decimal
    value_in: Decimal
    cash_amount: Decimal
    cash_method: Optional[str] = None
    # Profit realised on the pairs given (value out minus their cost); None if a cost is unknown.
    profit: Optional[Decimal] = None
    transaction_ids: list[UUID]
    received_item_ids: list[UUID]
    created_at: Optional[datetime] = None
