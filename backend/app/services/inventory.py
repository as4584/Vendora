"""Inventory service — State machine enforcement + stock mutation.

Per STATE_MACHINES.md:
  Inventory states: in_stock, listed, sold, shipped, paid, archived
  Transitions are strictly enforced.
  Cannot revert from paid → in_stock.
  archived is a terminal state.

Stock mutation functions (deduct_stock / restore_stock) are the sole
write path for quantity changes. Every mutation writes an immutable
InventoryStockLedger entry. Callers should supply an idempotency_key
so that webhook replays or duplicate calls are safe no-ops.
"""
import logging
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem, InventoryStockLedger

logger = logging.getLogger(__name__)


# ─── State machine ────────────────────────────────────────────────────────────

VALID_TRANSITIONS: dict[str, list[str]] = {
    "in_stock": ["listed", "sold"],
    "listed": ["sold", "in_stock"],
    "sold": ["shipped", "paid"],
    "shipped": ["paid"],
    "paid": ["archived"],
    "archived": [],  # terminal state
}

ALL_STATUSES = list(VALID_TRANSITIONS.keys())


def validate_transition(current_status: str, target_status: str) -> bool:
    """Check if a state transition is allowed."""
    return target_status in VALID_TRANSITIONS.get(current_status, [])


def transition_item(item: InventoryItem, new_status: str, db: Session) -> InventoryItem:
    """Transition an inventory item to a new status.

    Raises HTTPException 400 if the transition is invalid.
    """
    if new_status not in ALL_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invalid_status",
                "message": f"'{new_status}' is not a valid status.",
                "valid_statuses": ALL_STATUSES,
            },
        )

    if not validate_transition(item.status, new_status):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invalid_transition",
                "message": f"Cannot transition from '{item.status}' to '{new_status}'.",
                "current_status": item.status,
                "target_status": new_status,
                "allowed_transitions": VALID_TRANSITIONS[item.status],
            },
        )

    item.status = new_status
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


# ─── Stock availability helpers ───────────────────────────────────────────────

def get_available_quantity(item: InventoryItem) -> int:
    """Return how many sellable units this item has right now.

    Returns 0 for sold/shipped/paid/archived items or soft-deleted items,
    regardless of the stored quantity field.
    """
    if item.deleted_at or item.status in ("sold", "shipped", "paid", "archived"):
        return 0
    return max(item.quantity, 0)


def check_availability(item: InventoryItem, requested_qty: int) -> None:
    """Raise HTTP 409 if the item does not have enough available stock."""
    available = get_available_quantity(item)
    if available < requested_qty:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "insufficient_stock",
                "message": (
                    f"Only {available} unit(s) available for '{item.name}'. "
                    f"{requested_qty} requested."
                ),
                "available": available,
                "requested": requested_qty,
                "item_id": str(item.id),
            },
        )


# ─── Stock mutation ───────────────────────────────────────────────────────────

def deduct_stock(
    db: Session,
    item: InventoryItem,
    quantity: int,
    event_type: str,
    source_type: str,
    source_id: str,
    idempotency_key: Optional[str] = None,
) -> Optional[InventoryStockLedger]:
    """Deduct *quantity* units from *item*, write a ledger entry, and transition
    status to 'sold' when stock reaches zero.

    Idempotency: if *idempotency_key* is provided and a ledger entry with that
    key already exists, the existing entry is returned and nothing else happens.
    This makes invoice-payment and webhook handlers safe to replay.

    Raises HTTP 409 if available stock is insufficient.
    Returns the InventoryStockLedger entry (existing or newly created).
    """
    if idempotency_key:
        existing = (
            db.query(InventoryStockLedger)
            .filter(InventoryStockLedger.idempotency_key == idempotency_key)
            .first()
        )
        if existing:
            return existing

    check_availability(item, quantity)

    new_qty = item.quantity - quantity
    item.quantity = new_qty
    if new_qty <= 0 and item.status in ("in_stock", "listed"):
        item.status = "sold"
    db.add(item)

    entry = InventoryStockLedger(
        inventory_item_id=item.id,
        user_id=item.user_id,
        delta_quantity=-quantity,
        quantity_after=new_qty,
        event_type=event_type,
        source_type=source_type,
        source_id=source_id,
        idempotency_key=idempotency_key,
    )
    db.add(entry)
    db.flush()  # make entry visible to same-session queries (needed with autoflush=False)
    return entry


def restore_stock(
    db: Session,
    item: InventoryItem,
    quantity: int,
    event_type: str,
    source_type: str,
    source_id: str,
    idempotency_key: Optional[str] = None,
) -> Optional[InventoryStockLedger]:
    """Restore *quantity* units to *item* (refund), write a ledger entry, and
    revert status from 'sold' → 'in_stock' when stock rises above zero.

    Idempotency: same as deduct_stock — returns the existing entry on replay.
    Returns the InventoryStockLedger entry (existing or newly created).
    """
    if idempotency_key:
        existing = (
            db.query(InventoryStockLedger)
            .filter(InventoryStockLedger.idempotency_key == idempotency_key)
            .first()
        )
        if existing:
            return existing

    new_qty = item.quantity + quantity
    item.quantity = new_qty
    if item.status == "sold" and new_qty > 0:
        item.status = "in_stock"
        item.actual_sell_price = None
    db.add(item)

    entry = InventoryStockLedger(
        inventory_item_id=item.id,
        user_id=item.user_id,
        delta_quantity=quantity,
        quantity_after=new_qty,
        event_type=event_type,
        source_type=source_type,
        source_id=source_id,
        idempotency_key=idempotency_key,
    )
    db.add(entry)
    db.flush()  # make entry visible to same-session queries (needed with autoflush=False)
    return entry
