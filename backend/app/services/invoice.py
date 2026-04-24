"""Invoice service — state machine enforcement + Stripe integration.

Per STATE_MACHINES.md:
    draft → sent
    sent → paid
    sent → cancelled
    paid → (locked)

Rules:
    Paid invoices cannot be edited.
    Cancelled invoices cannot be paid.
    Stripe webhook triggers paid transition.
"""
import logging
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.invoice import Invoice, InvoiceItem
from app.models.inventory import InventoryItem
from app.models.transaction import Transaction
from app.services.profit import calculate_net_amount
from app.services.inventory import deduct_stock

logger = logging.getLogger(__name__)


VALID_INVOICE_TRANSITIONS: dict[str, list[str]] = {
    "draft": ["sent"],
    "sent": ["paid", "cancelled"],
    "paid": [],       # locked
    "cancelled": [],  # terminal
}

ALL_INVOICE_STATUSES = list(VALID_INVOICE_TRANSITIONS.keys())


def validate_invoice_transition(current: str, target: str) -> bool:
    return target in VALID_INVOICE_TRANSITIONS.get(current, [])


def transition_invoice(invoice: Invoice, new_status: str, db: Session) -> Invoice:
    """Transition invoice status with state machine enforcement."""
    if new_status not in ALL_INVOICE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invalid_status",
                "message": f"'{new_status}' is not a valid invoice status.",
                "valid_statuses": ALL_INVOICE_STATUSES,
            },
        )

    if not validate_invoice_transition(invoice.status, new_status):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invalid_transition",
                "message": f"Cannot transition invoice from '{invoice.status}' to '{new_status}'.",
                "current_status": invoice.status,
                "target_status": new_status,
                "allowed_transitions": VALID_INVOICE_TRANSITIONS[invoice.status],
            },
        )

    invoice.status = new_status
    db.add(invoice)
    db.commit()
    db.refresh(invoice)
    return invoice


def calculate_invoice_totals(
    items: list,
    tax: Decimal = Decimal("0.00"),
    shipping: Decimal = Decimal("0.00"),
    discount: Decimal = Decimal("0.00"),
) -> dict:
    """Calculate invoice subtotal, total, and line totals."""
    line_totals = []
    for item in items:
        lt = Decimal(str(item.unit_price)) * item.quantity
        line_totals.append(lt)

    subtotal = sum(line_totals, Decimal("0.00"))
    total = subtotal + Decimal(str(tax)) + Decimal(str(shipping)) - Decimal(str(discount))

    return {
        "subtotal": subtotal,
        "total": max(total, Decimal("0.00")),
        "line_totals": line_totals,
    }


def process_invoice_payment(invoice: Invoice, db: Session) -> None:
    """Called when an invoice is marked as paid (via Stripe webhook or manual transition).

    For each line item:
    - Creates a Transaction record linked back to the invoice.
    - Deducts stock from any linked inventory item via the shared stock service.
      Uses an idempotency key so that webhook replays or double-calls are safe no-ops.
    """
    invoice_items = db.query(InvoiceItem).filter(
        InvoiceItem.invoice_id == invoice.id
    ).all()

    for inv_item in invoice_items:
        method = "stripe" if invoice.stripe_payment_intent_id else "other"
        txn = Transaction(
            user_id=invoice.user_id,
            item_id=inv_item.inventory_item_id,
            invoice_id=invoice.id,
            method=method,
            status="completed",
            gross_amount=inv_item.line_total,
            fee_amount=Decimal("0.00"),
            net_amount=inv_item.line_total,
            quantity=inv_item.quantity,
            notes=f"Invoice #{str(invoice.id)[:8]} \u2014 {inv_item.description}",
            is_refund=False,
        )
        db.add(txn)

        if inv_item.inventory_item_id:
            item = db.query(InventoryItem).filter(
                InventoryItem.id == inv_item.inventory_item_id,
                InventoryItem.deleted_at.is_(None),
            ).first()
            if item:
                # Set actual sell price regardless of stock path taken
                item.actual_sell_price = inv_item.unit_price
                db.add(item)
                # Route stock deduction through the shared service with idempotency
                idem_key = f"invoice:{invoice.id}:invitem:{inv_item.id}:pay"
                try:
                    deduct_stock(
                        db,
                        item,
                        quantity=inv_item.quantity,
                        event_type="sale",
                        source_type="invoice",
                        source_id=str(invoice.id),
                        idempotency_key=idem_key,
                    )
                except HTTPException:
                    # Migration compatibility: item may already be in 'sold' state from
                    # a prior flow that didn't track quantity.  Fall back to a direct
                    # status flip so existing data keeps working.
                    logger.warning(
                        "deduct_stock failed for item %s on invoice %s — "
                        "falling back to direct status transition.",
                        item.id, invoice.id,
                    )
                    if item.status in ("in_stock", "listed"):
                        item.status = "sold"
                        db.add(item)

    db.commit()
