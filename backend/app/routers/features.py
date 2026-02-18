"""Features router — feature flags + tier info.

Endpoints:
    GET /api/v1/features       — Get feature flags for current user
    GET /api/v1/features/tiers — Get tier comparison info
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.services.feature_flags import get_feature_flags, get_tier_info, FEATURES

router = APIRouter(prefix="/features", tags=["features"])


@router.get("")
def get_user_features(
    current_user: User = Depends(get_current_user),
):
    """Get all feature flags for the current user's tier."""
    flags = get_feature_flags(
        current_user.subscription_tier,
        current_user.is_partner,
    )
    return {
        "tier": current_user.subscription_tier,
        "is_partner": current_user.is_partner,
        "features": flags,
    }


@router.get("/tiers")
def get_tiers():
    """Get tier comparison for subscription upgrade flow."""
    return {
        "tiers": {
            "free": get_tier_info("free"),
            "pro": get_tier_info("pro"),
        },
        "partner_addon": {
            "price": 5,
            "requires": "pro",
            "features": [
                k for k, v in FEATURES.items()
                if v.get("requires_partner")
            ],
        },
    }
