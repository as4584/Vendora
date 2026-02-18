"""Stripe webhook router — idempotent event processing.

Per ROADMAP Sprint 3:
    - Webhook handler (idempotent)
    - Event ID deduplication

Events handled:
    - payment_intent.succeeded → Invoice paid → Transactions + Inventory
    - customer.subscription.created → User upgraded to Pro
    - customer.subscription.deleted → User downgraded to Free
    - invoice.payment_failed → Subscription past_due
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import settings
from app.services.stripe_service import (
    is_event_processed,
    record_event,
    handle_payment_intent_succeeded,
    handle_subscription_event,
    STRIPE_AVAILABLE,
)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


HANDLED_EVENTS = {
    "payment_intent.succeeded",
    "customer.subscription.created",
    "customer.subscription.deleted",
    "invoice.payment_failed",
}


@router.post("/stripe")
async def stripe_webhook(
    request: Request,
    db: Session = Depends(get_db),
):
    """Process Stripe webhook events with idempotency.

    1. Verify signature
    2. Check deduplication
    3. Route to handler
    4. Record processed event
    """
    body = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    # Verify webhook signature if Stripe is available
    if STRIPE_AVAILABLE and settings.STRIPE_WEBHOOK_SECRET:
        import stripe
        try:
            event = stripe.Webhook.construct_event(
                body, sig_header, settings.STRIPE_WEBHOOK_SECRET
            )
        except stripe.error.SignatureVerificationError:
            raise HTTPException(status_code=400, detail="Invalid signature")
    else:
        # In test/dev mode without Stripe, parse the JSON directly
        import json
        try:
            event = json.loads(body)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid JSON payload")

    event_id = event.get("id", "")
    event_type = event.get("type", "")

    # Skip unhandled event types
    if event_type not in HANDLED_EVENTS:
        return {"status": "ignored", "type": event_type}

    # Deduplication: check if already processed
    if is_event_processed(db, event_id):
        return {"status": "already_processed", "event_id": event_id}

    event_data = event.get("data", {})

    # Route to appropriate handler
    if event_type == "payment_intent.succeeded":
        handle_payment_intent_succeeded(db, event_data)
    elif event_type in (
        "customer.subscription.created",
        "customer.subscription.deleted",
        "invoice.payment_failed",
    ):
        handle_subscription_event(db, event_type, event_data)

    # Record the event as processed
    record_event(db, event_id, event_type)

    return {"status": "processed", "type": event_type}
