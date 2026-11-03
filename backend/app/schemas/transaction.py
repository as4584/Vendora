"""Transaction Pydantic schemas — request/response validation."""
from datetime import datetime
from decimal import Decimal
from uuid import UUID
from typing import Optional, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


PAYMENT_METHODS = Literal["stripe", "cashapp", "paypal", "zelle", "venmo", "cash", "card", "other"]
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
    discount_amount: Decimal = Decimal("0.00")
    tax_amount: Decimal = Decimal("0.00")
    variant_size: Optional[str] = None
    cost_amount: Optional[Decimal] = None
    created_at: datetime
    updated_at: datetime


PART_METHODS = Literal["stripe", "cashapp", "paypal", "zelle", "venmo", "cash", "card", "other"]


class SaleOrderLine(BaseModel):
    item_id: UUID
    quantity: int = Field(default=1, ge=1)
    # Price actually agreed per unit (haggled), not necessarily the list price.
    unit_price: Decimal = Field(ge=0, max_digits=10, decimal_places=2)
    # Size variant sold, for items with custom_attributes.variants.
    size: Optional[str] = Field(None, min_length=1, max_length=50)


class PaymentPart(BaseModel):
    method: PART_METHODS
    amount: Decimal = Field(gt=0, max_digits=10, decimal_places=2)


class SaleOrderCreate(BaseModel):
    """One checkout with one or more items, recorded all-or-nothing.

    Pay with a single `method` (the full total), or with `payments`, a list of
    parts that must add up exactly to the total (subtotal - discount + tax).
    """
    lines: list[SaleOrderLine] = Field(min_length=1, max_length=100)
    method: Optional[PART_METHODS] = None
    payments: Optional[list[PaymentPart]] = Field(None, min_length=1, max_length=10)
    fee_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=10, decimal_places=2)
    # Order-level discount: a fixed amount OR a percent of the subtotal.
    discount_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=10, decimal_places=2)
    discount_percent: Optional[Decimal] = Field(None, ge=0, le=100, max_digits=5, decimal_places=2)
    # Sales tax percent applied to the discounted subtotal (e.g. 6.625).
    tax_rate: Decimal = Field(default=Decimal("0"), ge=0, le=30, max_digits=6, decimal_places=3)
    notes: Optional[str] = Field(None, max_length=500)
    client_request_id: Optional[str] = Field(None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")

    def amounts(self):
        from app.services.checkout import compute_order_amounts

        return compute_order_amounts(
            [(line.unit_price, line.quantity) for line in self.lines],
            discount_amount=self.discount_amount,
            discount_percent=self.discount_percent,
            tax_rate=self.tax_rate,
        )

    def payment_parts(self) -> list[PaymentPart]:
        if self.payments:
            return list(self.payments)
        total = self.amounts().total
        return [PaymentPart(method=self.method, amount=total)] if total > 0 else []

    @model_validator(mode="after")
    def check_amounts(self):
        if self.discount_percent is not None and self.discount_amount > 0:
            raise ValueError("Use a discount amount or a discount percent, not both")
        if (self.method is None) == (self.payments is None):
            raise ValueError("Provide either method or payments")
        amounts = self.amounts()  # raises ValueError for a discount above the subtotal
        if self.fee_amount > amounts.gross:
            raise ValueError("Fee cannot exceed the order total")
        if self.payments is not None:
            paid = sum((p.amount for p in self.payments), Decimal("0.00"))
            if paid != amounts.total:
                raise ValueError(
                    f"Payments add up to {paid} but the order total is {amounts.total}"
                )
        return self


class OrderPaymentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    method: str
    amount: Decimal


class SaleOrderResponse(BaseModel):
    order_id: UUID
    subtotal_amount: Decimal = Decimal("0.00")
    discount_amount: Decimal = Decimal("0.00")
    # Revenue after discount, excluding tax (kept for older app builds).
    gross_amount: Decimal
    tax_amount: Decimal = Decimal("0.00")
    # What the customer paid: gross + tax.
    total_amount: Decimal = Decimal("0.00")
    fee_amount: Decimal
    net_amount: Decimal
    payments: list[OrderPaymentResponse] = []
    created_at: Optional[datetime] = None
    transactions: list[TransactionResponse]


class TransactionListResponse(BaseModel):
    items: list[TransactionResponse]
    total: int
    page: int
    per_page: int
    pages: int
