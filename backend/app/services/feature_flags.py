"""Feature flags service — Sprint 4 Modular Expansion.

Controls which features are available based on tier and overrides.
Per MONETIZATION_AND_LIMITS.md:
    Free: basic dashboard, manual logging, 25 items
    Pro: unlimited items, Stripe, barcode, invoices, CSV, analytics
    Partner: verified badge, seller page, priority support
"""


# ─── Feature definitions ──────────────────────────────

FEATURES = {
    # Core — available to all tiers
    "inventory_crud": {"tiers": ["free", "pro"], "description": "Create/edit/delete inventory items"},
    "manual_payment": {"tiers": ["free", "pro"], "description": "Log manual payments"},
    "dashboard_basic": {"tiers": ["free", "pro"], "description": "Basic revenue dashboard"},
    "quick_sale": {"tiers": ["free", "pro"], "description": "Quick sale flow"},

    # Pro-only features
    "barcode_scanning": {"tiers": ["pro"], "description": "Scan UPC barcodes to add items"},
    "csv_export": {"tiers": ["pro"], "description": "Export inventory and transactions as CSV"},
    "invoices": {"tiers": ["pro"], "description": "Create and send customer invoices"},
    "stripe_payments": {"tiers": ["pro"], "description": "Accept Stripe payments"},
    "analytics_advanced": {"tiers": ["pro"], "description": "Advanced analytics and reporting"},
    "market_pricing": {"tiers": ["pro"], "description": "eBay comps and smart price suggestions"},
    "unlimited_items": {"tiers": ["pro"], "description": "Unlimited inventory items"},

    # Partner-only features
    "seller_page": {"tiers": ["pro"], "requires_partner": True, "description": "Public seller profile page"},
    "verified_badge": {"tiers": ["pro"], "requires_partner": True, "description": "Verified seller badge"},
    "priority_support": {"tiers": ["pro"], "requires_partner": True, "description": "Priority in-app support"},
}


def get_feature_flags(tier: str, is_partner: bool = False) -> dict[str, bool]:
    """Get all feature flags for a given tier/partner status."""
    flags = {}
    for name, config in FEATURES.items():
        enabled = tier in config["tiers"]
        if config.get("requires_partner") and not is_partner:
            enabled = False
        flags[name] = enabled
    return flags


def is_feature_enabled(feature: str, tier: str, is_partner: bool = False) -> bool:
    """Check if a specific feature is enabled."""
    config = FEATURES.get(feature)
    if not config:
        return False
    if tier not in config["tiers"]:
        return False
    if config.get("requires_partner") and not is_partner:
        return False
    return True


def get_tier_info(tier: str) -> dict:
    """Get tier metadata for subscription upgrade flow."""
    tiers = {
        "free": {
            "name": "Free",
            "price": 0,
            "item_limit": 25,
            "features": [k for k, v in FEATURES.items() if "free" in v["tiers"] and not v.get("requires_partner")],
        },
        "pro": {
            "name": "Pro",
            "price": 20,
            "item_limit": None,  # unlimited
            "features": [k for k, v in FEATURES.items() if "pro" in v["tiers"] and not v.get("requires_partner")],
        },
    }
    return tiers.get(tier, tiers["free"])


def require_market_pricing(current_user):
    """Raise 403 pro_required unless the user can see market pricing."""
    from fastapi import HTTPException, status
    if not is_feature_enabled("market_pricing", current_user.subscription_tier) and not in_pricing_grace(current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "pro_required",
                "message": "Price suggestions and eBay comps are part of Pro ($20/mo).",
                "feature": "market_pricing",
            },
        )


def _aware_iso(value: str):
    from datetime import datetime, timezone
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def in_pricing_grace(user, now=None) -> bool:
    """Early free users keep market pricing until the grace end."""
    from datetime import datetime, timezone
    end = pricing_grace_end(user)
    return end is not None and (now or datetime.now(timezone.utc)) < end


def pricing_grace_end(user):
    """When this user's free market-pricing grace ends, or None if not eligible."""
    from datetime import timedelta, timezone
    from app.config import settings
    if not settings.PRICING_GRACE_CUTOFF or not getattr(user, "created_at", None):
        return None
    try:
        cutoff = _aware_iso(settings.PRICING_GRACE_CUTOFF)
        until = (_aware_iso(settings.PRICING_GRACE_UNTIL) if settings.PRICING_GRACE_UNTIL
                 else cutoff + timedelta(days=settings.PRICING_GRACE_DAYS))
    except ValueError:
        return None
    created = user.created_at if user.created_at.tzinfo else user.created_at.replace(tzinfo=timezone.utc)
    return until if created < cutoff else None
