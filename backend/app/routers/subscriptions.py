"""Subscription upgrade and billing management endpoints."""
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.subscription import Subscription
from app.models.user import User
from app.services.stripe_service import create_billing_portal, create_subscription_checkout

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])


class CheckoutRequest(BaseModel):
    plan: Literal["pro", "partner"] = "pro"


@router.get("/me")
def get_subscription_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    subscription = db.query(Subscription).filter(Subscription.user_id == current_user.id).first()
    return {
        "tier": current_user.subscription_tier,
        "is_partner": current_user.is_partner,
        "status": subscription.status if subscription else "none",
        "current_period_end": subscription.current_period_end if subscription else None,
        "managed_billing": bool(subscription and subscription.stripe_customer_id),
    }


@router.post("/checkout")
def create_checkout(
    body: CheckoutRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return create_subscription_checkout(db, current_user, body.plan)


@router.post("/portal")
def create_portal(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return create_billing_portal(db, current_user)
