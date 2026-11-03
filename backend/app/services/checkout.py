"""Checkout math: discounts, sales tax and payment parts, all in Decimal cents.

Definitions used everywhere (receipts, dashboard, show summary):
    subtotal  = sum(unit_price x quantity) over lines
    discount  = order-level discount (fixed $ or % of subtotal)
    gross     = subtotal - discount          (revenue; profit is based on it)
    tax       = gross x tax_rate%            (collected for the state, never profit)
    total     = gross + tax                  (what the customer pays)

Order-level amounts are split per line in proportion to line value with
allocate(); the last line takes the rounding remainder so the parts always
sum exactly to the order amount.
"""
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")
ZERO = Decimal("0.00")


def cents(value: Decimal) -> Decimal:
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def allocate(amount: Decimal, weights: list[Decimal]) -> list[Decimal]:
    """Split *amount* across lines in proportion to *weights* (to the cent).

    Parts sum exactly to *amount*. Lines with zero weight get zero, and the
    remainder lands on the last line that has weight, so a free line never
    carries a fee, discount or tax.
    """
    total = sum(weights, ZERO)
    if amount == 0 or total == 0:
        return [ZERO] * len(weights)
    last = max(i for i, w in enumerate(weights) if w > 0)
    parts = [ZERO] * len(weights)
    for i, weight in enumerate(weights):
        if i != last:
            parts[i] = cents(amount * weight / total)
    parts[last] = amount - sum(parts, ZERO)
    return parts


@dataclass
class OrderAmounts:
    line_subtotals: list[Decimal]
    line_discounts: list[Decimal]
    line_grosses: list[Decimal]
    line_taxes: list[Decimal]
    subtotal: Decimal
    discount: Decimal
    gross: Decimal
    tax: Decimal
    total: Decimal


def compute_order_amounts(
    lines: list[tuple[Decimal, int]],
    discount_amount: Decimal = ZERO,
    discount_percent: Decimal | None = None,
    tax_rate: Decimal = ZERO,
) -> OrderAmounts:
    """*lines* are (unit_price, quantity). Raises ValueError on a bad discount."""
    subtotals = [cents(price * qty) for price, qty in lines]
    subtotal = sum(subtotals, ZERO)
    if discount_percent is not None:
        discount = cents(subtotal * discount_percent / 100)
    else:
        discount = cents(discount_amount or ZERO)
    if discount < 0:
        raise ValueError("Discount cannot be negative")
    if discount > subtotal:
        raise ValueError("Discount cannot exceed the subtotal")
    discounts = allocate(discount, subtotals)
    grosses = [s - d for s, d in zip(subtotals, discounts, strict=True)]
    gross = subtotal - discount
    tax = cents(gross * (tax_rate or ZERO) / 100)
    taxes = allocate(tax, grosses)
    return OrderAmounts(
        line_subtotals=subtotals,
        line_discounts=discounts,
        line_grosses=grosses,
        line_taxes=taxes,
        subtotal=subtotal,
        discount=discount,
        gross=gross,
        tax=tax,
        total=gross + tax,
    )
