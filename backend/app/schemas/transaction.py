"""Transaction Pydantic schemas — request/response validation."""
from datetime import datetime
from decimal import Decimal
from uuid import UUID
from typing import Optional, Literal

from pydantic import BaseModel, Field, model_validator


PAYMENT_METHODS = Literal["stripe", "cashapp", "paypal", "zelle", "venmo", "cash", "other"]
TRANSACTION_STATUSES = Literal["pending", "completed", "failed", "refunded"]


class TransactionCreate(BaseModel):
    """Create a new transaction (manual payment log or Quick Sale)."""
    item_id: Optional[UUID] = None
    method: PAYMENT_METHODS
    gross_amount: Decimal = Field(ge=0, max_digits=10, decimal_places=2)
    fee_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=10, decimal_places=2)
    external_reference_id: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=500)

    @model_validator(mode="after")
    def check_amounts(self):
        if self.fee_amount > self.gross_amount:
            raise ValueError("Fee cannot exceed gross amount")
        return self


class RefundCreate(BaseModel):
    """Create a refund for an existing transaction."""
    reason: Optional[str] = Field(None, max_length=500)


class TransactionResponse(BaseModel):
    id: UUID
    user_id: UUID
    item_id: Optional[UUID] = None
    method: str
    status: str
    gross_amount: Decimal
    fee_amount: Decimal
    net_amount: Decimal
    external_reference_id: Optional[str] = None
    notes: Optional[str] = None
    is_refund: bool
    original_transaction_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class TransactionListResponse(BaseModel):
    items: list[TransactionResponse]
    total: int
    page: int
    per_page: int
    pages: int
