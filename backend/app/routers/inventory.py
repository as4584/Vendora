"""Inventory router — /api/v1/inventory endpoints.

Soft-delete 404 rule: All GET/PUT/PATCH filter WHERE deleted_at IS NULL.
Soft-deleted records return 404, never exposed.
"""
import math
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
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
    PhotoUpdate,
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
        quantity=payload.quantity,
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


@router.get("/market-price")
async def get_market_price(
    query: str = Query(..., description="Item name to look up"),
    upc: str | None = Query(None, description="UPC barcode if known"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Market price lookup. Queries UPC database + internal Vendora history."""
    result: dict = {"query": query, "upc": upc, "product_info": None, "sources": []}

    # 1. UPC item lookup via free upcitemdb trial (no API key required)
    if upc:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(
                    "https://api.upcitemdb.com/prod/trial/lookup",
                    params={"upc": upc},
                    headers={"User-Agent": "Vendora/1.0"},
                )
            if r.status_code == 200:
                items = r.json().get("items", [])
                if items:
                    i = items[0]
                    result["product_info"] = {
                        "name": i.get("title"),
                        "brand": i.get("brand"),
                        "category": i.get("category"),
                        "images": (i.get("images") or [])[:2],
                    }
                    prices = [
                        float(o["price"])
                        for o in i.get("offers", [])
                        if o.get("price") and float(o.get("price", 0)) > 0
                    ]
                    if prices:
                        result["sources"].append({
                            "source": "retail",
                            "label": "Retail prices",
                            "low": round(min(prices), 2),
                            "high": round(max(prices), 2),
                            "avg": round(sum(prices) / len(prices), 2),
                            "count": len(prices),
                        })
        except Exception:
            pass  # graceful degradation

    # 2. Internal history — avg sell price for similar-named items in user's account
    name_avg = (
        db.query(func.avg(InventoryItem.actual_sell_price))
        .filter(
            InventoryItem.user_id == current_user.id,
            InventoryItem.actual_sell_price.isnot(None),
            InventoryItem.name.ilike(f"%{query[:20]}%"),
        )
        .scalar()
    )
    if name_avg:
        result["sources"].append({
            "source": "vendora_history",
            "label": "Your avg sell price",
            "avg": round(float(name_avg), 2),
        })

    return result


@router.get("/{item_id}/pricing-suggestion")
def get_pricing_suggestion(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Smart pricing suggestion using own sales history and buy price margin."""
    item = _get_active_item(item_id, current_user.id, db)

    category_avg = (
        db.query(func.avg(InventoryItem.actual_sell_price))
        .filter(
            InventoryItem.user_id == current_user.id,
            InventoryItem.actual_sell_price.isnot(None),
            InventoryItem.category == item.category,
            InventoryItem.id != item.id,
        )
        .scalar()
    ) if item.category else None

    name_avg = (
        db.query(func.avg(InventoryItem.actual_sell_price))
        .filter(
            InventoryItem.user_id == current_user.id,
            InventoryItem.actual_sell_price.isnot(None),
            InventoryItem.name.ilike(f"%{item.name[:15]}%"),
            InventoryItem.id != item.id,
        )
        .scalar()
    )

    margin_30 = round(float(item.buy_price) * 1.30, 2) if item.buy_price else None

    if name_avg:
        suggested = round(float(name_avg), 2)
        reason = "Based on your historical sales for similar items"
    elif category_avg:
        suggested = round(float(category_avg), 2)
        reason = f"Based on your {item.category} category average"
    elif margin_30:
        suggested = margin_30
        reason = "30% margin over your buy price"
    else:
        suggested = None
        reason = "Add more sales data to unlock smart suggestions"

    return {
        "item_id": str(item.id),
        "current_expected": float(item.expected_sell_price) if item.expected_sell_price else None,
        "suggested_price": suggested,
        "reason": reason,
        "category_avg": round(float(category_avg), 2) if category_avg else None,
        "name_avg": round(float(name_avg), 2) if name_avg else None,
        "margin_30_percent": margin_30,
    }


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


@router.patch("/{item_id}/photos", response_model=ItemResponse)
def update_item_photos(
    item_id: str,
    payload: PhotoUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update front/back photo (base64 data URL). Called after createItem succeeds."""
    item = _get_active_item(item_id, current_user.id, db)
    if payload.photo_front is not None:
        item.photo_front_url = payload.photo_front
    if payload.photo_back is not None:
        item.photo_back_url = payload.photo_back
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


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
