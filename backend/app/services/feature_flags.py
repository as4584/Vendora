"""Feature flags service — Sprint 4 Modular Expansion.

Controls which features are available based on tier and overrides.
Per MONETIZATION_AND_LIMITS.md:
    Free: basic dashboard, manual logging, 25 items
    Pro: unlimited items, Stripe, barcode, invoices, CSV, analytics
    Partner: verified badge, seller page, priority support
"""
from typing import Optional


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
    "unlimited_items": {"tiers": ["pro"], "description": "Unlimited inventory items"},

    # Partner-only features
    "seller_page": {"tiers": ["pro"], "requires_partner": True, "description": "Public seller profile page"},
    "verified_badge": {"tiers": ["pro"], "requires_partner": True, "description": "Verified seller badge"},
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
