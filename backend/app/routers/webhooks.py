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
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import settings
from app.services.stripe_service import (
    claim_event,
    release_event_claim,
    record_event,
    handle_payment_intent_succeeded,
    handle_subscription_event,
    STRIPE_AVAILABLE,
)

from app.services.revenuecat_service import handle_revenuecat_event, HANDLED as RC_HANDLED

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


UNSIGNED_WEBHOOK_ENVIRONMENTS = frozenset({"development", "testing"})

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

    # Fail closed: unsigned events are only ever accepted in local dev/tests,
    # never in production, staging, or a mistyped ENVIRONMENT value.
    if settings.ENVIRONMENT not in UNSIGNED_WEBHOOK_ENVIRONMENTS and (
        not STRIPE_AVAILABLE or not settings.STRIPE_WEBHOOK_SECRET
    ):
        raise HTTPException(
            status_code=503, detail="Stripe webhook verification is not configured."
        )

    # Verify webhook signature if Stripe is available (skip in test environment)
    if STRIPE_AVAILABLE and settings.STRIPE_WEBHOOK_SECRET and settings.ENVIRONMENT != "testing":
        import stripe
        try:
            event = stripe.Webhook.construct_event(
                body, sig_header, settings.STRIPE_WEBHOOK_SECRET
            )
        except stripe.SignatureVerificationError:
            raise HTTPException(status_code=400, detail="Invalid signature")
        except ValueError:
            # Missing/garbled signature header or a body that is not JSON.
            raise HTTPException(status_code=400, detail="Invalid webhook payload")
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

    if not event_id:
        raise HTTPException(status_code=400, detail="Webhook event is missing an id.")

    # Claim before side effects. The unique event-id index prevents concurrent
    # deliveries from entering the handler at the same time.
    if claim_event(db, event_id, event_type) is None:
        return {"status": "already_processed", "event_id": event_id}

    event_data = event.get("data", {})

    # Route to appropriate handler
    try:
        if event_type == "payment_intent.succeeded":
            handle_payment_intent_succeeded(db, event_data)
        else:
            handle_subscription_event(db, event_type, event_data)
        record_event(db, event_id, event_type)
    except Exception:
        db.rollback()
        release_event_claim(db, event_id)
        raise

    return {"status": "processed", "type": event_type}


@router.post("/revenuecat")
async def revenuecat_webhook(
    request: Request,
    db: Session = Depends(get_db),
):
    """Apple in-app purchase events from RevenueCat (idempotent by event id)."""
    import hmac
    import json

    expected = settings.REVENUECAT_WEBHOOK_AUTH
    if not expected:
        raise HTTPException(status_code=503, detail="RevenueCat webhook is not configured.")
    supplied = request.headers.get("authorization", "")
    if not hmac.compare_digest(supplied.encode(), expected.encode()) and not hmac.compare_digest(
        supplied.encode(), f"Bearer {expected}".encode()
    ):
        raise HTTPException(status_code=401, detail="Invalid authorization")

    try:
        payload = json.loads(await request.body())
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")
    event = payload.get("event") or {}
    event_type = event.get("type", "")
    if event_type not in RC_HANDLED:
        return {"status": "ignored", "type": event_type}
    event_id = event.get("id")
    if not event_id:
        raise HTTPException(status_code=400, detail="Webhook event is missing an id.")

    claim_id = f"rc:{event_id}"
    if claim_event(db, claim_id, f"rc:{event_type}"[:100]) is None:
        return {"status": "already_processed", "event_id": event_id}
    try:
        outcome = handle_revenuecat_event(db, event)
        record_event(db, claim_id, f"rc:{event_type}"[:100])
    except Exception:
        db.rollback()
        release_event_claim(db, claim_id)
        raise
    return {"status": outcome, "type": event_type}
