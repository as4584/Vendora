"""Inventory service — State machine enforcement.

Per STATE_MACHINES.md:
  Inventory states: in_stock, listed, sold, shipped, paid, archived
  Transitions are strictly enforced.
  Cannot revert from paid → in_stock.
  archived is a terminal state.
"""
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem


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
