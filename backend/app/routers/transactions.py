"""Transaction router — /api/v1/transactions

Endpoints:
    POST   /transactions           — Log a sale (manual payment)
    GET    /transactions           — List transactions (paginated)
    GET    /transactions/{id}      — Get transaction
    POST   /transactions/{id}/refund — Refund a transaction
"""
import math
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.models.transaction import Transaction
from app.models.inventory import InventoryItem
from app.schemas.transaction import (
    TransactionCreate,
    TransactionResponse,
    TransactionListResponse,
    RefundCreate,
)
from app.services.profit import calculate_net_amount
from app.services.inventory import transition_item

router = APIRouter(prefix="/transactions", tags=["transactions"])


@router.post("", response_model=TransactionResponse, status_code=status.HTTP_201_CREATED)
def create_transaction(
    payload: TransactionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Log a manual payment / quick sale.

    If item_id is provided:
    - Updates item's actual_sell_price
    - Transitions item to 'sold' if currently 'in_stock' or 'listed'
    """
    # Validate item ownership if provided
    item = None
    if payload.item_id:
        item = db.query(InventoryItem).filter(
            InventoryItem.id == payload.item_id,
            InventoryItem.user_id == current_user.id,
            InventoryItem.deleted_at.is_(None),
        ).first()
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")

    net = calculate_net_amount(payload.gross_amount, payload.fee_amount)

    txn = Transaction(
        user_id=current_user.id,
        item_id=payload.item_id,
        method=payload.method,
        status="completed",
        gross_amount=payload.gross_amount,
        fee_amount=payload.fee_amount,
        net_amount=net,
        external_reference_id=payload.external_reference_id,
        notes=payload.notes,
        is_refund=False,
    )
    db.add(txn)

    # Update item if linked
    if item:
        item.actual_sell_price = payload.gross_amount
        # Auto-transition to sold if currently in_stock or listed
        if item.status in ("in_stock", "listed"):
            item.status = "sold"
        db.add(item)

    db.commit()
    db.refresh(txn)
    return txn


@router.get("", response_model=TransactionListResponse)
def list_transactions(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List transactions for the current user, paginated."""
    query = db.query(Transaction).filter(
        Transaction.user_id == current_user.id,
    ).order_by(Transaction.created_at.desc())

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
    txn_id: str,
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
    txn_id: str,
    payload: RefundCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a refund for an existing transaction.

    Per STATE_MACHINES.md: Refund creates negative transaction entry.
    - Creates a new transaction with is_refund=True and negative net_amount
    - Marks original transaction as 'refunded'
    - Reverts item to 'in_stock' if item is still in 'sold' status
    """
    original = db.query(Transaction).filter(
        Transaction.id == txn_id,
        Transaction.user_id == current_user.id,
    ).first()
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

    # Create refund transaction (negative amounts)
    refund_txn = Transaction(
        user_id=current_user.id,
        item_id=original.item_id,
        method=original.method,
        status="completed",
        gross_amount=original.gross_amount,
        fee_amount=Decimal("0.00"),  # Fees are not refunded
        net_amount=-original.net_amount,  # Negative net
        notes=payload.reason or f"Refund of transaction {original.id}",
        is_refund=True,
        original_transaction_id=original.id,
    )
    db.add(refund_txn)

    # Mark original as refunded
    original.status = "refunded"
    db.add(original)

    # Revert item status if applicable
    if original.item_id:
        item = db.query(InventoryItem).filter(
            InventoryItem.id == original.item_id,
            InventoryItem.user_id == current_user.id,
            InventoryItem.deleted_at.is_(None),
        ).first()
        if item and item.status == "sold":
            item.status = "in_stock"
            item.actual_sell_price = None
            db.add(item)

    db.commit()
    db.refresh(refund_txn)
    return refund_txn
