"""Transaction router — /api/v1/transactions

Endpoints:
    POST   /transactions           — Log a sale (manual payment)
    GET    /transactions           — List transactions (paginated)
    GET    /transactions/{id}      — Get transaction
    POST   /transactions/{id}/refund — Refund a transaction
"""
import logging
import math
import uuid
from decimal import Decimal

from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.services import analytics
from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.models.transaction import OrderPayment, Transaction
from app.models.inventory import InventoryItem
from app.schemas.transaction import (
    OrderPaymentResponse,
    SaleOrderCreate,
    SaleOrderResponse,
    TransactionCreate,
    TransactionResponse,
    TransactionListResponse,
    RefundCreate,
)
from app.services.customers import get_owned_customer
from app.services.profit import calculate_net_amount
from app.services.checkout import allocate
from app.services.invoice_pdf import generate_receipt_pdf
from app.services.inventory import deduct_stock, restore_stock, get_available_quantity
from app.services.invoice import (
    _deduct_variant_quantity,
    _variant_rows,
    check_invoice_item_availability,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/transactions", tags=["transactions"])


CLIENT_REQUEST_SOURCE = "app"


def _find_client_request(db: Session, user_id, reference: str) -> Transaction | None:
    return db.query(Transaction).filter(
        Transaction.user_id == user_id,
        Transaction.source == CLIENT_REQUEST_SOURCE,
        Transaction.external_reference_id == reference,
    ).first()


@router.post("", response_model=TransactionResponse, status_code=status.HTTP_201_CREATED)
def create_transaction(
    payload: TransactionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Log a manual payment / quick sale.

    If item_id is provided:
    - Validates that sufficient stock is available.
    - Updates item's actual_sell_price.
    - Deducts stock via the shared stock service (writes ledger entry).
    - Transitions item to 'sold' if stock reaches zero.
    - Replays with the same client_request_id return the original sale.
    """
    source = None
    reference = payload.external_reference_id
    if payload.client_request_id and not reference:
        source = CLIENT_REQUEST_SOURCE
        reference = payload.client_request_id
        existing = _find_client_request(db, current_user.id, reference)
        if existing:
            return existing

    item = None
    if payload.item_id:
        item = db.query(InventoryItem).filter(
            InventoryItem.id == payload.item_id,
            InventoryItem.user_id == current_user.id,
            InventoryItem.deleted_at.is_(None),
        ).first()
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        # Validate stock before creating the transaction record
        check_qty = payload.quantity if payload.quantity else 1
        available = get_available_quantity(item)
        if available < check_qty:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "error": "insufficient_stock",
                    "message": f"Only {available} unit(s) available.",
                    "available": available,
                    "requested": check_qty,
                },
            )

    net = calculate_net_amount(payload.gross_amount, payload.fee_amount)
    qty = payload.quantity if payload.quantity else 1

    txn = Transaction(
        user_id=current_user.id,
        item_id=payload.item_id,
        method=payload.method,
        status="completed",
        gross_amount=payload.gross_amount,
        fee_amount=payload.fee_amount,
        net_amount=net,
        quantity=qty,
        external_reference_id=reference,
        source=source,
        notes=payload.notes,
        is_refund=False,
    )
    db.add(txn)
    try:
        db.flush()  # get txn.id before writing ledger
    except IntegrityError:
        # A concurrent replay of the same request won the race.
        db.rollback()
        existing = _find_client_request(db, current_user.id, reference) if source else None
        if existing:
            return existing
        raise

    if item:
        item.actual_sell_price = payload.gross_amount
        db.add(item)
        idem_key = f"txn:{txn.id}:sale"
        try:
            deduct_stock(
                db,
                item,
                quantity=qty,
                event_type="sale",
                source_type="transaction",
                source_id=str(txn.id),
                idempotency_key=idem_key,
            )
        except HTTPException:
            # Backward-compat fallback: transition status directly if deduction fails
            logger.warning(
                "deduct_stock failed for item %s on txn %s — status-only transition.",
                item.id, txn.id,
            )
            item.status = "sold"
            db.add(item)

    db.commit()
    analytics.track_first(db, current_user.id, "sale_recorded")
    db.commit()
    db.refresh(txn)
    return txn


def _order_payments(db: Session, user_id, order_id) -> list[OrderPayment]:
    return (
        db.query(OrderPayment)
        .filter(OrderPayment.user_id == user_id, OrderPayment.order_id == order_id)
        .order_by(OrderPayment.created_at, OrderPayment.id)
        .all()
    )


def _order_response(txns: list[Transaction], payments: list[OrderPayment]) -> SaleOrderResponse:
    def total(attr: str) -> Decimal:
        return sum((getattr(t, attr) or Decimal("0.00") for t in txns), Decimal("0.00"))

    gross = total("gross_amount")
    discount = total("discount_amount")
    tax = total("tax_amount")
    return SaleOrderResponse(
        order_id=txns[0].order_id,
        subtotal_amount=gross + discount,
        discount_amount=discount,
        gross_amount=gross,
        tax_amount=tax,
        total_amount=gross + tax,
        fee_amount=total("fee_amount"),
        net_amount=total("net_amount"),
        payments=[OrderPaymentResponse.model_validate(p) for p in payments],
        customer_id=txns[0].customer_id,
        created_at=txns[0].created_at,
        transactions=[TransactionResponse.model_validate(t) for t in txns],
    )


def _load_order(db: Session, user_id, order_id) -> SaleOrderResponse | None:
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.user_id == user_id,
            Transaction.order_id == order_id,
            Transaction.is_refund.is_(False),
        )
        .order_by(Transaction.external_reference_id, Transaction.created_at, Transaction.id)
        .all()
    )
    if not txns:
        return None
    return _order_response(txns, _order_payments(db, user_id, order_id))


def _replayed_order(db: Session, user_id, client_request_id: str | None) -> SaleOrderResponse | None:
    if not client_request_id:
        return None
    first = _find_client_request(db, user_id, f"{client_request_id}:0")
    if first and first.order_id:
        return _load_order(db, user_id, first.order_id)
    return None


# Kept under its old name: tests and callers split fees with it.
_allocate_fee = allocate


def _variant_key(size: str | None) -> str | None:
    return size.strip().lower() if size else None


@router.post("/order", response_model=SaleOrderResponse, status_code=status.HTTP_201_CREATED)
def create_sale_order(
    payload: SaleOrderCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record a multi-item checkout atomically.

    Every line is validated (ownership, stock, size stock, counting repeated
    items together) before anything is written; then all lines and payment
    parts are written and committed together, so a dropped connection can
    never leave half a sale. Lines share an order_id. Replays with the same
    client_request_id return the original order.

    The order-level discount, sales tax and fee are each split across lines
    by value, to the cent, summing exactly. gross_amount on each line is its
    revenue after discount and before tax; tax is stored separately and never
    counted as profit.
    """
    replay = _replayed_order(db, current_user.id, payload.client_request_id)
    if replay:
        return replay

    items: dict = {}
    requested: dict = {}
    requested_sizes: dict = {}
    for line in payload.lines:
        if line.item_id not in items:
            item = db.query(InventoryItem).filter(
                InventoryItem.id == line.item_id,
                InventoryItem.user_id == current_user.id,
                InventoryItem.deleted_at.is_(None),
            ).with_for_update().first()
            if not item:
                raise HTTPException(status_code=404, detail=f"Item {line.item_id} not found")
            items[line.item_id] = item
        requested[line.item_id] = requested.get(line.item_id, 0) + line.quantity
        if line.size and _variant_rows(items[line.item_id]):
            key = (line.item_id, line.size.strip())
            requested_sizes[key] = requested_sizes.get(key, 0) + line.quantity
    for item_id, qty in requested.items():
        available = get_available_quantity(items[item_id])
        if available < qty:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "error": "insufficient_stock",
                    "message": f"Only {available} unit(s) of {items[item_id].name} available.",
                    "item_id": str(item_id),
                    "available": available,
                    "requested": qty,
                },
            )
    for (item_id, size), qty in requested_sizes.items():
        check_invoice_item_availability(items[item_id], qty, size)
    customer = get_owned_customer(db, current_user.id, payload.customer_id) if payload.customer_id else None

    amounts = payload.amounts()
    parts = payload.payment_parts()
    methods = {p.method for p in parts}
    if len(methods) == 1:
        line_method = parts[0].method
    elif methods:
        line_method = "split"
    else:  # a $0.00 order has no payment parts
        line_method = payload.method or "other"
    fees = allocate(payload.fee_amount, amounts.line_grosses)
    order_id = uuid.uuid4()
    txns: list[Transaction] = []
    payments: list[OrderPayment] = []
    try:
        for index, line in enumerate(payload.lines):
            gross = amounts.line_grosses[index]
            fee = fees[index]
            item = items[line.item_id]
            size = line.size.strip() if line.size else None
            txn = Transaction(
                user_id=current_user.id,
                item_id=line.item_id,
                customer_id=customer.id if customer else None,
                order_id=order_id,
                method=line_method,
                status="completed",
                gross_amount=gross,
                fee_amount=fee,
                net_amount=calculate_net_amount(gross, fee),
                discount_amount=amounts.line_discounts[index],
                tax_amount=amounts.line_taxes[index],
                variant_size=size,
                quantity=line.quantity,
                source=CLIENT_REQUEST_SOURCE if payload.client_request_id else None,
                external_reference_id=(
                    f"{payload.client_request_id}:{index}" if payload.client_request_id else None
                ),
                notes=payload.notes,
                is_refund=False,
            )
            db.add(txn)
            db.flush()
            item.actual_sell_price = line.unit_price
            if size and _variant_rows(item):
                _deduct_variant_quantity(item, size, line.quantity)
            db.add(item)
            # No status-only fallback here: if stock can't be deducted the
            # whole order is rolled back rather than half-recorded.
            deduct_stock(
                db,
                item,
                quantity=line.quantity,
                event_type="sale",
                source_type="transaction",
                source_id=str(txn.id),
                idempotency_key=f"txn:{txn.id}:sale",
            )
            txns.append(txn)
        for part in parts:
            payment = OrderPayment(
                user_id=current_user.id, order_id=order_id, method=part.method, amount=part.amount,
            )
            db.add(payment)
            payments.append(payment)
        db.commit()
    except IntegrityError:
        db.rollback()
        # A concurrent replay of the same order won the race.
        replay = _replayed_order(db, current_user.id, payload.client_request_id)
        if replay:
            return replay
        raise
    except Exception:
        db.rollback()
        raise
    for txn in txns:
        db.refresh(txn)
    return _order_response(txns, payments)


@router.get("/order/{order_id}", response_model=SaleOrderResponse)
def get_sale_order(
    order_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One checkout with its lines and payment parts (for receipts)."""
    order = _load_order(db, current_user.id, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order


@router.get("/order/{order_id}/receipt.pdf")
def get_sale_receipt_pdf(
    order_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The checkout's receipt as a PDF (same branding as invoices)."""
    order = _load_order(db, current_user.id, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    item_ids = [t.item_id for t in order.transactions if t.item_id]
    names = dict(
        db.query(InventoryItem.id, InventoryItem.name)
        .filter(InventoryItem.user_id == current_user.id, InventoryItem.id.in_(item_ids))
        .all()
    ) if item_ids else {}
    lines = []
    for t in order.transactions:
        qty = t.quantity or 1
        line_subtotal = (t.gross_amount or Decimal("0.00")) + (t.discount_amount or Decimal("0.00"))
        lines.append({
            "name": names.get(t.item_id) or "Item",
            "size": t.variant_size,
            "quantity": qty,
            "unit_price": (line_subtotal / qty).quantize(Decimal("0.01")),
            "line_total": line_subtotal,
        })
    payments = [{"method": p.method, "amount": p.amount} for p in order.payments] or [
        {"method": order.transactions[0].method, "amount": order.total_amount}
    ]
    number = f"R-{str(order.order_id).split('-')[0].upper()}"
    pdf = generate_receipt_pdf(
        user=current_user,
        receipt_number=number,
        created_at=order.created_at,
        lines=lines,
        subtotal=order.subtotal_amount,
        discount=order.discount_amount,
        tax=order.tax_amount,
        total=order.total_amount,
        payments=payments,
    )
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="receipt-{number}.pdf"'},
    )


@router.get("", response_model=TransactionListResponse)
def list_transactions(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    item_id: UUID | None = Query(None, description="Filter by inventory item id"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List transactions for the current user, paginated."""
    query = db.query(Transaction).filter(
        Transaction.user_id == current_user.id,
    ).order_by(Transaction.created_at.desc())
    if item_id:
        query = query.filter(Transaction.item_id == item_id)

    total = query.count()
    pages = math.ceil(total / per_page) if total > 0 else 0
    items = query.offset((page - 1) * per_page).limit(per_page).all()

    return TransactionListResponse(
        items=items,
        total=total,
        page=page,
        per_page=per_page,
        pages=pages,
    )


@router.get("/{txn_id}", response_model=TransactionResponse)
def get_transaction(
    txn_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single transaction by ID."""
    txn = db.query(Transaction).filter(
        Transaction.id == txn_id,
        Transaction.user_id == current_user.id,
    ).first()
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return txn


@router.post("/{txn_id}/refund", response_model=TransactionResponse, status_code=status.HTTP_201_CREATED)
def refund_transaction(
    txn_id: UUID,
    payload: RefundCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a refund for an existing transaction.

    Per STATE_MACHINES.md: Refund creates negative transaction entry.
    - Creates a new transaction with is_refund=True and negative net_amount.
    - Marks original transaction as 'refunded'.
    - Restores stock via the shared stock service (writes ledger entry).
    """
    original = db.query(Transaction).filter(
        Transaction.id == txn_id,
        Transaction.user_id == current_user.id,
    # Lock the row so a double tap or retry can't refund it twice.
    ).with_for_update().first()
    if not original:
        raise HTTPException(status_code=404, detail="Transaction not found")

    if original.is_refund:
        raise HTTPException(status_code=400, detail={
            "error": "cannot_refund_refund",
            "message": "Cannot refund a refund transaction.",
        })

    if original.status == "refunded":
        raise HTTPException(status_code=400, detail={
            "error": "already_refunded",
            "message": "This transaction has already been refunded.",
        })

    refund_txn = Transaction(
        user_id=current_user.id,
        item_id=original.item_id,
        customer_id=original.customer_id,
        invoice_id=original.invoice_id,
        method=original.method,
        status="completed",
        gross_amount=original.gross_amount,
        fee_amount=Decimal("0.00"),
        net_amount=-original.net_amount,
        discount_amount=original.discount_amount or Decimal("0.00"),
        tax_amount=original.tax_amount or Decimal("0.00"),
        variant_size=original.variant_size,
        order_id=original.order_id,
        quantity=original.quantity,
        notes=payload.reason or f"Refund of transaction {original.id}",
        is_refund=True,
        original_transaction_id=original.id,
    )
    db.add(refund_txn)
    db.flush()  # get refund_txn.id before writing ledger

    original.status = "refunded"
    db.add(original)

    if original.item_id:
        item = db.query(InventoryItem).filter(
            InventoryItem.id == original.item_id,
            InventoryItem.user_id == current_user.id,
            InventoryItem.deleted_at.is_(None),
        ).first()
        if item:
            restore_qty = original.quantity if original.quantity else 1
            if original.variant_size and _variant_rows(item):
                _restore_variant_quantity(item, original.variant_size, restore_qty)
            idem_key = f"txn:{original.id}:refund"
            try:
                restore_stock(
                    db,
                    item,
                    quantity=restore_qty,
                    event_type="refund",
                    source_type="transaction",
                    source_id=str(refund_txn.id),
                    idempotency_key=idem_key,
                )
            except HTTPException:
                # Backward-compat fallback
                logger.warning(
                    "restore_stock failed for item %s on refund of txn %s — status-only revert.",
                    item.id, original.id,
                )
                if item.status == "sold":
                    item.status = "in_stock"
                    item.actual_sell_price = None
                    db.add(item)

    db.commit()
    db.refresh(refund_txn)
    return refund_txn


def _restore_variant_quantity(item: InventoryItem, size: str, quantity: int) -> None:
    """Put refunded units back on the size they were sold from."""
    variants = [dict(v) for v in _variant_rows(item)]
    key = _variant_key(size)
    for variant in variants:
        if _variant_key(str(variant.get("size") or "")) == key:
            variant["quantity"] = max(0, int(variant.get("quantity") or 0)) + quantity
            attrs = dict(item.custom_attributes or {})
            attrs["variants"] = variants
            item.custom_attributes = attrs
            flag_modified(item, "custom_attributes")
            return
