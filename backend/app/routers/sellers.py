"""Public seller page router — Partner tier feature.

Endpoints:
    GET /api/v1/sellers/{user_id} — Public seller profile (no auth required)
"""
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app.models.user import User
from app.models.inventory import InventoryItem
from app.models.transaction import Transaction

router = APIRouter(prefix="/sellers", tags=["sellers"])


@router.get("/{user_id}")
def get_public_seller_profile(
    user_id: str,
    db: Session = Depends(get_db),
):
    """Get public seller profile. Only available for Partner users.

    No auth required — this is a public-facing page.
    Per RISK_REGISTER.md: Never imply financial guarantees.
    """
    user = db.query(User).filter(
        User.id == user_id,
        User.deleted_at.is_(None),
    ).first()

    if not user:
        raise HTTPException(status_code=404, detail="Seller not found")

    if not user.is_partner:
        raise HTTPException(
            status_code=404,
            detail="This seller does not have a public profile.",
        )

    # Gather public stats
    total_items = db.query(func.count(InventoryItem.id)).filter(
        InventoryItem.user_id == user.id,
        InventoryItem.deleted_at.is_(None),
    ).scalar() or 0

    items_sold = db.query(func.count(InventoryItem.id)).filter(
        InventoryItem.user_id == user.id,
        InventoryItem.status == "sold",
        InventoryItem.deleted_at.is_(None),
    ).scalar() or 0

    total_transactions = db.query(func.count(Transaction.id)).filter(
        Transaction.user_id == user.id,
        Transaction.status == "completed",
        Transaction.is_refund == False,
    ).scalar() or 0

    # Active listings for public display
    active_items = db.query(InventoryItem).filter(
        InventoryItem.user_id == user.id,
        InventoryItem.status.in_(["in_stock", "listed"]),
        InventoryItem.deleted_at.is_(None),
    ).order_by(InventoryItem.created_at.desc()).limit(20).all()

    return {
        "seller": {
            "id": str(user.id),
            "business_name": user.business_name or "Vendora Seller",
            "is_partner": user.is_partner,
            "verified": user.is_partner,  # Partner = verified badge
            "member_since": user.created_at.isoformat() if user.created_at else None,
        },
        "stats": {
            "total_items": total_items,
            "items_sold": items_sold,
            "total_transactions": total_transactions,
        },
        "listings": [
            {
                "id": str(item.id),
                "name": item.name,
                "category": item.category,
                "size": item.size,
                "color": item.color,
                "condition": item.condition,
                "price": str(item.expected_sell_price) if item.expected_sell_price else None,
                "status": item.status,
            }
            for item in active_items
        ],
        "disclaimer": "This is a seller profile. Vendora does not guarantee any transactions. All payments are processed by Stripe.",
    }
