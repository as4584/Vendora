"""Inventory router — /api/v1/inventory endpoints.

Soft-delete 404 rule: All GET/PUT/PATCH filter WHERE deleted_at IS NULL.
Soft-deleted records return 404, never exposed.
"""
import math
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.inventory import InventoryItem
from app.schemas.inventory import (
    ItemCreate,
    ItemUpdate,
    ItemResponse,
    StatusUpdate,
    PaginatedItems,
)
from app.dependencies.auth import get_current_user
from app.dependencies.tier_limiter import enforce_item_limit
from app.services.inventory import transition_item

router = APIRouter(prefix="/inventory", tags=["inventory"])


def _get_active_item(item_id: str, user_id, db: Session) -> InventoryItem:
    """Helper: fetch an active (non-deleted), user-owned inventory item or raise 404."""
    item = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.id == item_id,
            InventoryItem.user_id == user_id,
            InventoryItem.deleted_at.is_(None),
        )
        .first()
    )
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Item not found.",
        )
    return item


@router.post("", response_model=ItemResponse, status_code=status.HTTP_201_CREATED)
def create_item(
    payload: ItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(enforce_item_limit),
):
    """Create a new inventory item. Tier limit enforced (Free: 25 max)."""
    item = InventoryItem(
        user_id=current_user.id,
        name=payload.name,
        category=payload.category,
        sku=payload.sku,
        upc=payload.upc,
        size=payload.size,
        color=payload.color,
        condition=payload.condition,
        serial_number=payload.serial_number,
        custom_attributes=payload.custom_attributes or {},
        buy_price=payload.buy_price,
        expected_sell_price=payload.expected_sell_price,
        actual_sell_price=payload.actual_sell_price,
        platform=payload.platform,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("", response_model=PaginatedItems)
def list_items(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List inventory items with pagination. Only shows active (non-deleted) items."""
    base_query = db.query(InventoryItem).filter(
        InventoryItem.user_id == current_user.id,
        InventoryItem.deleted_at.is_(None),
    )
    total = base_query.count()
    items = (
        base_query
        .order_by(InventoryItem.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return PaginatedItems(
        items=items,
        total=total,
        page=page,
        per_page=per_page,
        pages=math.ceil(total / per_page) if total > 0 else 0,
    )


@router.get("/{item_id}", response_model=ItemResponse)
def get_item(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single inventory item. Returns 404 if deleted or not owned."""
    return _get_active_item(item_id, current_user.id, db)


@router.put("/{item_id}", response_model=ItemResponse)
def update_item(
    item_id: str,
    payload: ItemUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update an inventory item. Cannot update status here — use PATCH /status."""
    item = _get_active_item(item_id, current_user.id, db)

    update_data = payload.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(item, field, value)

    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete an inventory item. Sets deleted_at = now().
    Item can be recovered within 30 days.
    """
    item = _get_active_item(item_id, current_user.id, db)
    item.deleted_at = datetime.now(timezone.utc)
    db.add(item)
    db.commit()
    return None


@router.patch("/{item_id}/status", response_model=ItemResponse)
def update_status(
    item_id: str,
    payload: StatusUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Transition item status. Enforces STATE_MACHINES.md transition rules."""
    item = _get_active_item(item_id, current_user.id, db)
    return transition_item(item, payload.status, db)
