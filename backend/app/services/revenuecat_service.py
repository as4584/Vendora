"""Apple in-app purchase entitlements, reported by RevenueCat webhooks.

The iOS app identifies RevenueCat customers by the Resqlo user id
(``Purchases.logIn(user.id)``), so ``app_user_id`` maps straight to a user.
Each Apple product gets one ``Subscription`` row (provider="apple"); the
user's tier is then recomputed from *all* active rows, Stripe and Apple alike,
so buying on the web or in the app unlocks the same features.

Products (one App Store subscription group, so upgrades/downgrades are handled
by Apple):
    com.vendora.pro.monthly      -> Pro
    com.vendora.pro.yearly       -> Pro
    com.vendora.partner.monthly  -> Pro + Partner
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models.subscription import Subscription
from app.models.user import User

PRODUCTS: dict[str, dict] = {
    "com.vendora.pro.monthly": {"partner": False, "price": Decimal("19.99")},
    "com.vendora.pro.yearly": {"partner": False, "price": Decimal("16.67")},
    "com.vendora.partner.monthly": {"partner": True, "price": Decimal("24.99")},
}

ACTIVATE = {"INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "SUBSCRIPTION_EXTENDED"}
# CANCELLATION only turns off auto-renew; access continues until EXPIRATION.
KEEP = {"CANCELLATION", "TEST"}
EXPIRE = {"EXPIRATION"}
PAST_DUE = {"BILLING_ISSUE"}

HANDLED = ACTIVATE | KEEP | EXPIRE | PAST_DUE


def recompute_entitlements(db: Session, user: User) -> None:
    active = db.query(Subscription).filter(
        Subscription.user_id == user.id,
        Subscription.status.in_(("active", "past_due")),
        Subscription.tier == "pro",
    ).all()
    user.subscription_tier = "pro" if active else "free"
    user.is_partner = any(entry.is_partner for entry in active)
    db.add(user)


def _ms_to_dt(value) -> datetime | None:
    if not value:
        return None
    return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)


def _find_user(db: Session, event: dict) -> User | None:
    candidates = [event.get("app_user_id"), event.get("original_app_user_id"), *(event.get("aliases") or [])]
    for candidate in candidates:
        try:
            user_id = uuid.UUID(str(candidate))
        except (TypeError, ValueError):
            continue
        user = db.query(User).filter(User.id == user_id).first()
        if user:
            return user
    return None


def handle_revenuecat_event(db: Session, event: dict) -> str:
    """Apply one RevenueCat webhook event. Returns a short outcome string."""
    event_type = event.get("type", "")
    if event_type not in HANDLED:
        return "ignored"
    if event_type == "TEST":
        return "test"

    user = _find_user(db, event)
    if user is None:
        return "unknown_user"

    product_id = event.get("new_product_id") if event_type == "PRODUCT_CHANGE" else event.get("product_id")
    product = PRODUCTS.get(product_id or "")
    if product is None:
        return "unknown_product"

    if event_type == "PRODUCT_CHANGE":
        # The old product's row is superseded by the new one.
        old = db.query(Subscription).filter(
            Subscription.user_id == user.id,
            Subscription.provider == "apple",
            Subscription.store_product_id == event.get("product_id"),
        ).first()
        if old:
            old.status = "cancelled"
            db.add(old)

    sub = db.query(Subscription).filter(
        Subscription.user_id == user.id,
        Subscription.provider == "apple",
        Subscription.store_product_id == product_id,
    ).first()
    if sub is None:
        sub = Subscription(user_id=user.id, provider="apple", store_product_id=product_id, tier="pro")

    sub.tier = "pro"
    sub.is_partner = product["partner"]
    sub.price_monthly = product["price"]
    expires = _ms_to_dt(event.get("expiration_at_ms"))
    if expires:
        sub.current_period_end = expires

    if event_type in ACTIVATE:
        sub.status = "active"
    elif event_type in PAST_DUE:
        sub.status = "past_due"
    elif event_type in EXPIRE:
        sub.status = "cancelled"
    elif sub.status is None:
        sub.status = "active"
    db.add(sub)
    db.flush()

    recompute_entitlements(db, user)
    db.commit()
    return "processed"
