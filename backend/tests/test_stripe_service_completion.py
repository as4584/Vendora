"""Direct coverage for Stripe service validation and subscription events."""
from types import SimpleNamespace
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models.invoice import Invoice
from app.models.subscription import Subscription, WebhookEvent
from app.services import stripe_service


def _invoice(db, user, *, status="sent", total=Decimal("12.34")):
    model = Invoice(
        user_id=user.id,
        customer_name="Stripe Buyer",
        status=status,
        subtotal=total,
        tax=Decimal("0"),
        shipping=Decimal("0"),
        discount=Decimal("0"),
        total=total,
    )
    db.add(model)
    db.commit()
    db.refresh(model)
    return model


class TestStripePayments:
    def test_payment_intent_validation_and_success(self, db, test_user, monkeypatch):
        invoice = _invoice(db, test_user)
        monkeypatch.setattr(stripe_service, "STRIPE_AVAILABLE", False)
        with pytest.raises(HTTPException) as unavailable:
            stripe_service.create_payment_intent(db, invoice, test_user)
        assert unavailable.value.status_code == 503

        monkeypatch.setattr(stripe_service, "STRIPE_AVAILABLE", True)
        monkeypatch.setattr(stripe_service.settings, "STRIPE_PRO_PRICE_ID", "price_pro_test")
        with pytest.raises(HTTPException) as tier:
            stripe_service.create_payment_intent(db, invoice, test_user)
        assert tier.value.status_code == 403

        test_user.subscription_tier = "pro"
        db.add(test_user)
        db.commit()
        invoice.status = "draft"
        with pytest.raises(HTTPException) as state:
            stripe_service.create_payment_intent(db, invoice, test_user)
        assert state.value.status_code == 400

        observed = {}

        class PaymentIntent:
            @staticmethod
            def create(**kwargs):
                observed.update(kwargs)
                return SimpleNamespace(id="pi_coverage", client_secret="pi_secret")

        monkeypatch.setattr(
            stripe_service,
            "stripe",
            SimpleNamespace(PaymentIntent=PaymentIntent),
            raising=False,
        )
        invoice.status = "sent"
        result = stripe_service.create_payment_intent(db, invoice, test_user)
        assert result == {"client_secret": "pi_secret", "payment_intent_id": "pi_coverage"}
        assert observed["amount"] == 1234
        assert observed["metadata"]["invoice_id"] == str(invoice.id)
        db.refresh(invoice)
        assert invoice.stripe_payment_intent_id == "pi_coverage"

    def test_success_webhook_noops_and_processes(self, db, test_user, monkeypatch):
        stripe_service.handle_payment_intent_succeeded(db, {"object": {"id": "pi_none"}})
        stripe_service.handle_payment_intent_succeeded(
            db,
            {"object": {"metadata": {"invoice_id": "00000000-0000-0000-0000-000000000001"}}},
        )

        paid = _invoice(db, test_user, status="paid")
        stripe_service.handle_payment_intent_succeeded(
            db, {"object": {"metadata": {"invoice_id": str(paid.id)}}}
        )

        invoice = _invoice(db, test_user, status="sent")
        processed = []
        monkeypatch.setattr(
            stripe_service,
            "process_invoice_payment",
            lambda invoice_model, session: processed.append(str(invoice_model.id)),
        )
        stripe_service.handle_payment_intent_succeeded(
            db, {"object": {"id": "pi_ok", "metadata": {"invoice_id": str(invoice.id)}}}
        )
        db.refresh(invoice)
        assert invoice.status == "paid"
        assert processed == [str(invoice.id)]

    def test_checkout_unavailable_and_success(self, db, test_user, monkeypatch):
        monkeypatch.setattr(stripe_service, "STRIPE_AVAILABLE", False)
        with pytest.raises(HTTPException):
            stripe_service.create_subscription_checkout(db, test_user)

        observed = {}

        class CheckoutSession:
            @staticmethod
            def create(**kwargs):
                observed.update(kwargs)
                return SimpleNamespace(id="cs_coverage", url="https://checkout.example/session")

        monkeypatch.setattr(stripe_service, "STRIPE_AVAILABLE", True)
        monkeypatch.setattr(stripe_service.settings, "STRIPE_PRO_PRICE_ID", "price_pro_test")
        monkeypatch.setattr(
            stripe_service,
            "stripe",
            SimpleNamespace(checkout=SimpleNamespace(Session=CheckoutSession)),
            raising=False,
        )
        result = stripe_service.create_subscription_checkout(db, test_user)
        assert result["session_id"] == "cs_coverage"
        assert observed["mode"] == "subscription"
        assert observed["metadata"]["user_id"] == str(test_user.id)


class TestStripeSubscriptions:
    def test_created_updates_subscription_and_user(self, db, test_user):
        stripe_service.handle_subscription_event(
            db,
            "customer.subscription.created",
            {
                "object": {
                    "id": "sub_created",
                    "metadata": {"user_id": str(test_user.id)},
                    "current_period_end": 1893456000,
                }
            },
        )
        subscription = db.query(Subscription).filter_by(stripe_subscription_id="sub_created").one()
        assert subscription.status == "active"
        assert subscription.current_period_end is not None
        db.refresh(test_user)
        assert test_user.subscription_tier == "pro"

        stripe_service.handle_subscription_event(
            db,
            "customer.subscription.created",
            {"object": {"id": "sub_created", "metadata": {"user_id": str(test_user.id)}}},
        )
        assert db.query(Subscription).filter_by(user_id=test_user.id).count() == 1

    def test_deleted_and_failed_events_with_metadata_fallback(self, db, test_user):
        subscription = Subscription(
            user_id=test_user.id,
            stripe_subscription_id="sub_existing",
            tier="pro",
            price_monthly=Decimal("20.00"),
            status="active",
        )
        test_user.subscription_tier = "pro"
        db.add_all([subscription, test_user])
        db.commit()

        stripe_service.handle_subscription_event(
            db,
            "invoice.payment_failed",
            {"object": {"subscription": "sub_existing", "metadata": {}}},
        )
        db.refresh(subscription)
        assert subscription.status == "past_due"

        stripe_service.handle_subscription_event(
            db,
            "customer.subscription.deleted",
            {"object": {"id": "sub_existing", "metadata": {}}},
        )
        db.refresh(subscription)
        db.refresh(test_user)
        assert subscription.status == "cancelled"
        assert test_user.subscription_tier == "free"

    def test_subscription_events_noop_when_no_user_can_be_resolved(self, db):
        stripe_service.handle_subscription_event(
            db, "customer.subscription.deleted", {"object": {"id": "sub_missing", "metadata": {}}}
        )
        stripe_service.handle_subscription_event(
            db, "invoice.payment_failed", {"object": {"subscription": "sub_missing", "metadata": {}}}
        )

    def test_subscription_events_tolerate_missing_related_rows(self, db):
        missing_user = "00000000-0000-0000-0000-000000000099"
        stripe_service.handle_subscription_event(
            db,
            "customer.subscription.created",
            {"object": {"id": "sub_orphan", "metadata": {"user_id": missing_user}}},
        )
        assert db.query(Subscription).filter_by(stripe_subscription_id="sub_orphan").first() is None
        stripe_service.handle_subscription_event(
            db,
            "customer.subscription.deleted",
            {"object": {"id": "sub_absent", "metadata": {"user_id": missing_user}}},
        )
        stripe_service.handle_subscription_event(
            db,
            "invoice.payment_failed",
            {"object": {"subscription": "sub_absent", "metadata": {"user_id": missing_user}}},
        )
        stripe_service.handle_subscription_event(
            db,
            "unhandled.subscription.event",
            {"object": {"id": "sub_absent", "metadata": {"user_id": missing_user}}},
        )


class TestStripeEventBookkeeping:
    def test_record_updates_existing_unprocessed_event(self, db):
        event = WebhookEvent(event_id="evt_existing", event_type="old", processed=False)
        db.add(event)
        db.commit()
        assert stripe_service.is_event_processed(db, "evt_existing") is False
        stripe_service.record_event(db, "evt_existing", "new")
        db.refresh(event)
        assert event.processed is True
        assert stripe_service.is_event_processed(db, "evt_existing") is True

    def test_record_creates_new_event(self, db):
        stripe_service.record_event(db, "evt_new", "payment_intent.succeeded")
        event = db.query(WebhookEvent).filter_by(event_id="evt_new").one()
        assert event.processed is True

    def test_claim_integrity_race_rolls_back(self):
        class Query:
            def filter(self, *args):
                return self

            def first(self):
                return None

        state = {"rolled_back": False}
        fake_db = SimpleNamespace(
            query=lambda *args: Query(),
            add=lambda value: None,
            commit=lambda: (_ for _ in ()).throw(IntegrityError("insert", {}, Exception("duplicate"))),
            rollback=lambda: state.__setitem__("rolled_back", True),
        )
        assert stripe_service.claim_event(fake_db, "evt_race", "type") is None
        assert state["rolled_back"] is True
