"""Tier enforcement dependency.

Per MONETIZATION_AND_LIMITS:
  Free tier ($0/mo): max 25 inventory items
  Pro tier ($20/mo): unlimited
  Partner add-on (+$5/mo): boolean flag, does NOT affect item limits
"""
from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.inventory import InventoryItem
from app.dependencies.auth import get_current_user

TIER_LIMITS: dict[str, int | None] = {
    "free": 25,
    "pro": None,  # unlimited
}


def enforce_item_limit(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """Check tier-based item limit before creating a new inventory item.

    Applied as a dependency on POST /inventory only.
    Returns the current_user if within limits.
    """
    limit = TIER_LIMITS.get(current_user.subscription_tier)
    if limit is not None:
        count = (
            db.query(InventoryItem)
            .filter(
                InventoryItem.user_id == current_user.id,
                InventoryItem.deleted_at.is_(None),
            )
            .count()
        )
        if count >= limit:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": "tier_limit_reached",
                    "message": f"Free tier is limited to {limit} items. Upgrade to Pro ($20/mo) for unlimited inventory.",
                    "current_count": count,
                    "tier": current_user.subscription_tier,
                    "limit": limit,
                },
            )
    return current_user
