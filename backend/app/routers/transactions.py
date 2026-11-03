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
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.models.transaction import Transaction
from app.models.inventory import InventoryItem
from app.schemas.transaction import (
    SaleOrderCreate,
    SaleOrderResponse,
    TransactionCreate,
    TransactionResponse,
    TransactionListResponse,
    RefundCreate,
)
from app.services.profit import calculate_net_amount
from app.services.inventory import deduct_stock, restore_stock, get_available_quantity

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
    db.refresh(txn)
    return txn


def _order_response(txns: list[Transaction]) -> SaleOrderResponse:
    return SaleOrderResponse(
        order_id=txns[0].order_id,
        gross_amount=sum((t.gross_amount for t in txns), Decimal("0.00")),
        fee_amount=sum((t.fee_amount for t in txns), Decimal("0.00")),
        net_amount=sum((t.net_amount for t in txns), Decimal("0.00")),
        transactions=[TransactionResponse.model_validate(t) for t in txns],
    )


def _allocate_fee(fee: Decimal, grosses: list[Decimal]) -> list[Decimal]:
    """Split an order-level fee across lines in proportion to line gross.

    Rounds to cents; the last line takes the remainder so the parts always
    sum exactly to the fee.
    """
    total = sum(grosses, Decimal("0.00"))
    if fee == 0 or total == 0:
        return [Decimal("0.00")] * len(grosses)
    parts = [(fee * g / total).quantize(Decimal("0.01")) for g in grosses[:-1]]
    parts.append(fee - sum(parts, Decimal("0.00")))
    return parts


@router.post("/order", response_model=SaleOrderResponse, status_code=status.HTTP_201_CREATED)
def create_sale_order(
    payload: SaleOrderCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record a multi-item checkout atomically.

    Every line is validated (ownership, stock, counting repeated items
    together) before anything is written; then all lines are written and
    committed together, so a dropped connection can never leave half a sale.
    Lines share an order_id. Replays with the same client_request_id return
    the original order.
    """
    if payload.client_request_id:
        first = _find_client_request(db, current_user.id, f"{payload.client_request_id}:0")
        if first and first.order_id:
            existing = (
                db.query(Transaction)
                .filter(Transaction.user_id == current_user.id, Transaction.order_id == first.order_id)
                .order_by(Transaction.external_reference_id)
                .all()
            )
            return _order_response(existing)

    items: dict = {}
    requested: dict = {}
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

    order_id = uuid.uuid4()
    grosses = [(line.unit_price * line.quantity).quantize(Decimal("0.01")) for line in payload.lines]
    fees = _allocate_fee(payload.fee_amount, grosses)
    txns: list[Transaction] = []
    try:
        for index, (line, gross, fee) in enumerate(zip(payload.lines, grosses, fees, strict=True)):
            txn = Transaction(
                user_id=current_user.id,
                item_id=line.item_id,
                order_id=order_id,
                method=payload.method,
                status="completed",
                gross_amount=gross,
                fee_amount=fee,
                net_amount=calculate_net_amount(gross, fee),
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
            item = items[line.item_id]
            item.actual_sell_price = line.unit_price
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
        db.commit()
    except IntegrityError:
        db.rollback()
        # A concurrent replay of the same order won the race.
        if payload.client_request_id:
            first = _find_client_request(db, current_user.id, f"{payload.client_request_id}:0")
            if first and first.order_id:
                return _order_response(
                    db.query(Transaction)
                    .filter(Transaction.user_id == current_user.id, Transaction.order_id == first.order_id)
                    .order_by(Transaction.external_reference_id)
                    .all()
                )
        raise
    except Exception:
        db.rollback()
        raise
    for txn in txns:
        db.refresh(txn)
    return _order_response(txns)


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
        invoice_id=original.invoice_id,
        method=original.method,
        status="completed",
        gross_amount=original.gross_amount,
        fee_amount=Decimal("0.00"),
        net_amount=-original.net_amount,
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
