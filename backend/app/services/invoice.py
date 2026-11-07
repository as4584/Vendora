"""Invoice service — state machine enforcement + Stripe integration.

Per STATE_MACHINES.md:
    draft → sent
    draft → cancelled (void a draft)
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
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.orm import Session

from app.models.invoice import Invoice, InvoiceItem, InvoicePayment
from app.models.inventory import InventoryItem
from app.models.transaction import Transaction
from app.services.inventory import deduct_stock

logger = logging.getLogger(__name__)


VALID_INVOICE_TRANSITIONS: dict[str, list[str]] = {
    "draft": ["sent", "cancelled"],
    "sent": ["paid", "cancelled"],
    # Money has been taken, so it only moves forward. Recording payments is
    # the normal way here; a manual "paid" records the remaining balance.
    "partially_paid": ["paid"],
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


def _variant_rows(item: InventoryItem) -> list[dict]:
    attrs = item.custom_attributes or {}
    variants = attrs.get("variants")
    return variants if isinstance(variants, list) else []


def check_invoice_item_availability(item: InventoryItem, requested_qty: int, size_label: str | None = None) -> None:
    if not size_label:
        from app.services.inventory import check_availability

        check_availability(item, requested_qty)
        return

    normalized_size = size_label.strip().lower()
    for variant in _variant_rows(item):
        if str(variant.get("size") or "").strip().lower() != normalized_size:
            continue
        available = max(0, int(variant.get("quantity") or 0))
        if available >= requested_qty:
            return
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "insufficient_size_stock",
                "message": (
                    f"Only {available} unit(s) of size {size_label} available for '{item.name}'. "
                    f"{requested_qty} requested."
                ),
                "available": available,
                "requested": requested_qty,
                "item_id": str(item.id),
                "size": size_label,
            },
        )

    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "error": "size_not_available",
            "message": f"Size {size_label} is not available for '{item.name}'.",
            "available": 0,
            "requested": requested_qty,
            "item_id": str(item.id),
            "size": size_label,
        },
    )


def _deduct_variant_quantity(item: InventoryItem, size_label: str | None, quantity: int) -> None:
    if not size_label:
        return
    variants = _variant_rows(item)
    normalized_size = size_label.strip().lower()
    for variant in variants:
        if str(variant.get("size") or "").strip().lower() != normalized_size:
            continue
        variant["quantity"] = max(0, int(variant.get("quantity") or 0) - quantity)
        attrs = dict(item.custom_attributes or {})
        attrs["variants"] = variants
        item.custom_attributes = attrs
        flag_modified(item, "custom_attributes")
        return


CENT = Decimal("0.01")
PAYABLE_STATUSES = ("draft", "sent", "partially_paid")


def _money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(CENT)


def allocate(amount: Decimal, weights: list[Decimal]) -> list[Decimal]:
    """Split ``amount`` across lines by weight; the last line absorbs rounding."""
    if not weights:
        return []
    total_weight = sum(weights, Decimal("0"))
    parts: list[Decimal] = []
    for weight in weights[:-1]:
        share = (amount * weight / total_weight).quantize(CENT) if total_weight > 0 else Decimal("0.00")
        parts.append(share)
    parts.append(amount - sum(parts, Decimal("0.00")))
    return parts


def _deduct_invoice_stock(invoice: Invoice, items: list[InvoiceItem], db: Session) -> None:
    """Hand the goods over. Runs once, on the invoice's first payment, and
    freezes each line's cost of goods at that moment."""
    for inv_item in items:
        if not inv_item.inventory_item_id:
            continue
        item = db.query(InventoryItem).filter(
            InventoryItem.id == inv_item.inventory_item_id,
            InventoryItem.deleted_at.is_(None),
        ).first()
        if not item:
            continue
        if item.buy_price is not None:
            inv_item.cost_amount = _money(Decimal(str(item.buy_price)) * inv_item.quantity)
            db.add(inv_item)
        # Set actual sell price regardless of stock path taken
        item.actual_sell_price = inv_item.unit_price
        db.add(item)
        idem_key = f"invoice:{invoice.id}:invitem:{inv_item.id}:pay"
        try:
            _deduct_variant_quantity(item, inv_item.size_label, inv_item.quantity)
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


def record_invoice_payment(
    invoice: Invoice,
    amount,
    method: str,
    db: Session,
    note: str | None = None,
    client_request_id: str | None = None,
) -> InvoicePayment:
    """Record a partial or full payment and the sale transactions it books.

    Each payment writes one transaction per line, splitting the amount by
    line value (so per-item and per-category reports keep working). Cost of
    goods is booked by the same paid fraction using cumulative rounding:
    cost_this_payment = round(line_cost * paid_after / total)
                      - round(line_cost * paid_before / total)
    which telescopes, so when the invoice is paid in full the cost on its
    transactions sums to exactly the frozen line cost — never twice.
    Stock leaves inventory on the first payment. Replays with the same
    client_request_id return the original payment.
    """
    if client_request_id:
        existing = db.query(InvoicePayment).filter(
            InvoicePayment.user_id == invoice.user_id,
            InvoicePayment.client_request_id == client_request_id,
        ).first()
        if existing:
            return existing

    if invoice.status not in PAYABLE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invoice_not_payable",
                "message": f"A {invoice.status.replace('_', ' ')} invoice can't take payments.",
                "current_status": invoice.status,
            },
        )

    amount = _money(amount)
    total = _money(invoice.total)
    paid_before = _money(invoice.amount_paid)
    balance = total - paid_before
    if amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid_amount", "message": "Payment amount must be more than $0.00."},
        )
    if amount > balance:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "overpayment",
                "message": f"${amount} is more than the ${balance} balance due.",
                "balance_due": str(balance),
            },
        )

    items = (
        db.query(InvoiceItem)
        .filter(InvoiceItem.invoice_id == invoice.id)
        .order_by(InvoiceItem.id)
        .all()
    )
    first_payment = paid_before == 0
    if first_payment:
        _deduct_invoice_stock(invoice, items, db)

    paid_after = paid_before + amount
    grosses = allocate(amount, [_money(i.line_total) for i in items])
    for inv_item, gross in zip(items, grosses):
        cost = None
        if inv_item.cost_amount is not None:
            line_cost = _money(inv_item.cost_amount)
            cost = (line_cost * paid_after / total).quantize(CENT) - (
                line_cost * paid_before / total
            ).quantize(CENT)
        db.add(Transaction(
            user_id=invoice.user_id,
            item_id=inv_item.inventory_item_id,
            invoice_id=invoice.id,
            method=method,
            status="completed",
            gross_amount=gross,
            fee_amount=Decimal("0.00"),
            net_amount=gross,
            # Units count once: on the payment that handed the goods over.
            quantity=inv_item.quantity if first_payment else 0,
            # Explicit cost (possibly 0.00 on a later payment) so the
            # before_insert listener never re-books the full buy price.
            cost_amount=cost,
            notes=f"{invoice.invoice_number or 'Invoice'} — {inv_item.description}"[:500],
            is_refund=False,
        ))

    payment = InvoicePayment(
        invoice_id=invoice.id,
        user_id=invoice.user_id,
        amount=amount,
        method=method,
        note=note,
        client_request_id=client_request_id,
    )
    db.add(payment)
    invoice.amount_paid = paid_after
    invoice.status = "paid" if paid_after >= total else "partially_paid"
    db.add(invoice)
    db.commit()
    db.refresh(payment)
    return payment


def process_invoice_payment(invoice: Invoice, db: Session) -> None:
    """Pay whatever balance is left in one go (manual "mark paid" or the
    Stripe webhook). Goes through record_invoice_payment so it shares the
    same transaction and cost rules as partial payments.

    Callers may have already set ``invoice.status = "paid"``.
    """
    paid_before = _money(invoice.amount_paid)
    balance = _money(invoice.total) - paid_before
    method = "stripe" if invoice.stripe_payment_intent_id else "other"
    if balance <= 0:
        if paid_before == 0:
            # A $0 invoice still hands over its goods.
            items = db.query(InvoiceItem).filter(InvoiceItem.invoice_id == invoice.id).all()
            _deduct_invoice_stock(invoice, items, db)
        invoice.status = "paid"
        db.add(invoice)
        db.commit()
        return
    # Undo a caller's early "paid" so the payable check passes; the payment
    # sets the final status.
    invoice.status = "partially_paid" if paid_before > 0 else "sent"
    record_invoice_payment(invoice, balance, method, db)
