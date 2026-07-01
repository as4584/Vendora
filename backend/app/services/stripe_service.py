"""Stripe service — Connect, Payment Intents, Webhook processing.

Per ROADMAP Sprint 3:
    - Stripe Connect
    - Payment Intent creation
    - Webhook handler (idempotent)
    - Event ID deduplication
"""
from decimal import Decimal
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.models.invoice import Invoice
from app.models.subscription import Subscription, WebhookEvent
from app.models.user import User
from app.services.invoice import transition_invoice, process_invoice_payment
from app.config import settings

try:
    import stripe
    stripe.api_key = settings.STRIPE_SECRET_KEY
    STRIPE_AVAILABLE = bool(settings.STRIPE_SECRET_KEY)
except ImportError:
    STRIPE_AVAILABLE = False


def is_event_processed(db: Session, event_id: str) -> bool:
    """Check if a webhook event has already been processed (deduplication)."""
    return db.query(WebhookEvent).filter(
        WebhookEvent.event_id == event_id,
        WebhookEvent.processed.is_(True),
    ).first() is not None


def record_event(db: Session, event_id: str, event_type: str) -> None:
    """Record a processed webhook event."""
    event = db.query(WebhookEvent).filter(WebhookEvent.event_id == event_id).first()
    if event is None:
        event = WebhookEvent(event_id=event_id, event_type=event_type)
    event.processed = True
    db.add(event)
    db.commit()


def claim_event(db: Session, event_id: str, event_type: str) -> WebhookEvent | None:
    """Claim an event before side effects; a unique row serializes concurrent delivery."""
    if db.query(WebhookEvent.id).filter(WebhookEvent.event_id == event_id).first():
        return None
    event = WebhookEvent(event_id=event_id, event_type=event_type, processed=False)
    try:
        db.add(event)
        db.commit()
        db.refresh(event)
        return event
    except IntegrityError:
        db.rollback()
        return None


def release_event_claim(db: Session, event_id: str) -> None:
    """Release a failed claim so Stripe can safely retry the event."""
    db.query(WebhookEvent).filter(
        WebhookEvent.event_id == event_id,
        WebhookEvent.processed.is_(False),
    ).delete(synchronize_session=False)
    db.commit()


def create_payment_intent(
    db: Session,
    invoice: Invoice,
    user: User,
) -> dict:
    """Create a Stripe Payment Intent for an invoice.

    Returns the client_secret for the mobile app.
    """
    if not STRIPE_AVAILABLE:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe is not configured.",
        )

    if user.subscription_tier != "pro":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "pro_required",
                "message": "Stripe integration requires Pro tier ($20/mo).",
            },
        )

    if invoice.status != "sent":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invoice must be in 'sent' status to create a payment.",
        )

    # Convert total to cents for Stripe
    amount_cents = int(Decimal(str(invoice.total)) * 100)

    intent = stripe.PaymentIntent.create(
        amount=amount_cents,
        currency="usd",
        metadata={
            "invoice_id": str(invoice.id),
            "user_id": str(invoice.user_id),
        },
    )

    # Store the payment intent ID on the invoice
    invoice.stripe_payment_intent_id = intent.id
    db.add(invoice)
    db.commit()

    return {
        "client_secret": intent.client_secret,
        "payment_intent_id": intent.id,
    }


def handle_payment_intent_succeeded(db: Session, event_data: dict) -> None:
    """Process a successful Stripe payment.

    Called by the webhook handler after dedup check.
    Per STATE_MACHINES.md: Stripe webhook triggers paid transition.
    """
    payment_intent = event_data.get("object", {})
    pi_id = payment_intent.get("id")
    metadata = payment_intent.get("metadata", {})
    invoice_id = metadata.get("invoice_id")

    if not invoice_id:
        return

    invoice = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not invoice or invoice.status == "paid":
        return

    # Transition invoice to paid
    invoice.status = "paid"
    db.add(invoice)
    db.commit()
    db.refresh(invoice)

    # Process the payment (create transactions, update inventory)
    process_invoice_payment(invoice, db)


def create_subscription_checkout(db: Session, user: User, plan: str = "pro") -> dict:
    """Create a hosted Checkout session for a Pro or Partner upgrade."""
    if not STRIPE_AVAILABLE:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe is not configured.",
        )

    if plan not in {"pro", "partner"}:
        raise HTTPException(status_code=400, detail="plan must be 'pro' or 'partner'.")
    if plan == "pro" and user.subscription_tier == "pro":
        raise HTTPException(status_code=409, detail="This account already has Pro access.")

    line_items = []
    if user.subscription_tier != "pro":
        if not settings.STRIPE_PRO_PRICE_ID:
            raise HTTPException(status_code=503, detail="The Pro plan is not configured.")
        line_items.append({"price": settings.STRIPE_PRO_PRICE_ID, "quantity": 1})
    if plan == "partner":
        if user.is_partner:
            raise HTTPException(status_code=409, detail="This account already has Partner access.")
        if not settings.STRIPE_PARTNER_PRICE_ID:
            raise HTTPException(status_code=503, detail="The Partner add-on is not configured.")
        line_items.append({"price": settings.STRIPE_PARTNER_PRICE_ID, "quantity": 1})

    metadata = {"user_id": str(user.id), "plan": plan}
    existing = db.query(Subscription).filter(
        Subscription.user_id == user.id,
        Subscription.stripe_customer_id.isnot(None),
    ).first()
    checkout_args = {
        "mode": "subscription",
        "line_items": line_items,
        "metadata": metadata,
        "subscription_data": {"metadata": metadata},
        "success_url": "vendora://subscription/success?session_id={CHECKOUT_SESSION_ID}",
        "cancel_url": "vendora://subscription/cancel",
    }
    if existing and existing.stripe_customer_id:
        checkout_args["customer"] = existing.stripe_customer_id
    else:
        checkout_args["customer_email"] = user.email

    session = stripe.checkout.Session.create(
        **checkout_args,
    )

    return {
        "checkout_url": session.url,
        "session_id": session.id,
    }


def create_billing_portal(db: Session, user: User) -> dict:
    """Create a Stripe customer portal session for an existing subscriber."""
    if not STRIPE_AVAILABLE:
        raise HTTPException(status_code=503, detail="Stripe is not configured.")
    subscription = db.query(Subscription).filter(
        Subscription.user_id == user.id,
        Subscription.stripe_customer_id.isnot(None),
    ).first()
    if not subscription or not subscription.stripe_customer_id:
        raise HTTPException(status_code=404, detail="No managed subscription was found.")
    session = stripe.billing_portal.Session.create(
        customer=subscription.stripe_customer_id,
        return_url="vendora://subscription",
    )
    return {"portal_url": session.url}


def handle_subscription_event(db: Session, event_type: str, event_data: dict) -> None:
    """Process subscription-related webhook events."""
    subscription_data = event_data.get("object", {})
    stripe_sub_id = (
        subscription_data.get("subscription")
        if event_type == "invoice.payment_failed"
        else subscription_data.get("id")
    )
    metadata = subscription_data.get("metadata", {})
    user_id = metadata.get("user_id")

    if not user_id:
        # Try to find by Stripe subscription ID
        existing = db.query(Subscription).filter(
            Subscription.stripe_subscription_id == stripe_sub_id
        ).first()
        if existing:
            user_id = str(existing.user_id)

    if not user_id:
        return

    if event_type == "customer.subscription.created":
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            return
        # Create or update subscription
        sub = db.query(Subscription).filter(
            Subscription.stripe_subscription_id == stripe_sub_id
        ).first()
        if not sub:
            sub = Subscription(user_id=user_id)

        sub.stripe_subscription_id = stripe_sub_id
        sub.stripe_customer_id = subscription_data.get("customer")
        sub.tier = "pro"
        sub.price_monthly = Decimal("25.00" if metadata.get("plan") == "partner" and user.subscription_tier != "pro" else "5.00" if metadata.get("plan") == "partner" else "20.00")
        sub.status = "active"
        if subscription_data.get("current_period_end"):
            sub.current_period_end = datetime.fromtimestamp(
                subscription_data["current_period_end"], tz=timezone.utc
            )
        db.add(sub)

        # Upgrade user tier
        user.subscription_tier = "pro"
        if metadata.get("plan") == "partner":
            sub.is_partner = True
            user.is_partner = True
        db.add(user)

        db.commit()

    elif event_type == "customer.subscription.deleted":
        sub = db.query(Subscription).filter(
            Subscription.stripe_subscription_id == stripe_sub_id
        ).first()
        if sub:
            sub.status = "cancelled"
            db.add(sub)

        # Recompute entitlements from remaining active subscriptions. This keeps
        # Pro active when a separate Partner add-on is cancelled.
        db.flush()
        user = db.query(User).filter(User.id == user_id).first()
        if user:
            active = db.query(Subscription).filter(
                Subscription.user_id == user.id,
                Subscription.status == "active",
            ).all()
            user.subscription_tier = "pro" if active else "free"
            user.is_partner = any(entry.is_partner for entry in active)
            db.add(user)

        db.commit()

    elif event_type == "invoice.payment_failed":
        sub = db.query(Subscription).filter(
            Subscription.stripe_subscription_id == stripe_sub_id
        ).first()
        if sub:
            sub.status = "past_due"
            db.add(sub)
            db.commit()
