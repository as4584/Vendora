"""Stripe webhook tests — idempotency + event processing.

Tests the webhook endpoint with simulated Stripe events.
No actual Stripe API calls — tests the processing logic.
"""
import json
import uuid

import pytest


def _make_event(event_type: str, data: dict) -> dict:
    """Construct a simulated Stripe event payload."""
    return {
        "id": f"evt_{uuid.uuid4().hex[:24]}",
        "type": event_type,
        "data": data,
    }


class TestWebhookDeduplication:
    def test_event_processed_once(self, client):
        """Same event ID cannot be processed twice."""
        event = _make_event("payment_intent.succeeded", {
            "object": {
                "id": f"pi_{uuid.uuid4().hex}",
                "metadata": {},
            },
        })

        resp1 = client.post("/api/v1/webhooks/stripe",
                            content=json.dumps(event))
        assert resp1.status_code == 200
        assert resp1.json()["status"] == "processed"

        resp2 = client.post("/api/v1/webhooks/stripe",
                            content=json.dumps(event))
        assert resp2.status_code == 200
        assert resp2.json()["status"] == "already_processed"

    def test_unhandled_event_ignored(self, client):
        event = _make_event("some.random.event", {"object": {}})
        resp = client.post("/api/v1/webhooks/stripe",
                           content=json.dumps(event))
        assert resp.status_code == 200
        assert resp.json()["status"] == "ignored"


class TestPaymentIntentWebhook:
    def test_payment_marks_invoice_paid(self, client, auth_headers):
        """Full Golden Frame: Create invoice → send → webhook → paid → inventory sold."""
        # Create item
        item = client.post("/api/v1/inventory", json={
            "name": "Yeezy 350 V2",
            "buy_price": "230.00",
        }, headers=auth_headers).json()

        # Create invoice linked to item
        invoice = client.post("/api/v1/invoices", json={
            "customer_name": "Webhook Tester",
            "items": [{
                "description": "Yeezy 350 V2",
                "quantity": 1,
                "unit_price": "380.00",
                "inventory_item_id": item["id"],
            }],
        }, headers=auth_headers).json()

        # Transition to sent
        client.patch(f"/api/v1/invoices/{invoice['id']}/status",
                     json={"status": "sent"}, headers=auth_headers)

        # Simulated Stripe webhook
        pi_id = f"pi_{uuid.uuid4().hex}"
        event = _make_event("payment_intent.succeeded", {
            "object": {
                "id": pi_id,
                "metadata": {"invoice_id": str(invoice["id"]), "user_id": "any"},
            },
        })
        resp = client.post("/api/v1/webhooks/stripe", content=json.dumps(event))
        assert resp.status_code == 200
        assert resp.json()["status"] == "processed"

        # Invoice should be paid
        updated_invoice = client.get(f"/api/v1/invoices/{invoice['id']}",
                                     headers=auth_headers).json()
        assert updated_invoice["status"] == "paid"

        # Item should be sold
        updated_item = client.get(f"/api/v1/inventory/{item['id']}",
                                  headers=auth_headers).json()
        assert updated_item["status"] == "sold"
        assert updated_item["actual_sell_price"] == "380.00"

        # Transaction should exist
        txns = client.get("/api/v1/transactions", headers=auth_headers).json()
        assert txns["total"] >= 1

        # Dashboard should reflect revenue
        dashboard = client.get("/api/v1/dashboard", headers=auth_headers).json()
        assert dashboard["items_sold"] >= 1


class TestSubscriptionWebhook:
    def test_subscription_created_upgrades_user(self, client, auth_headers, test_user):
        """Subscription webhook upgrades user to Pro."""
        event = _make_event("customer.subscription.created", {
            "object": {
                "id": f"sub_{uuid.uuid4().hex}",
                "metadata": {"user_id": str(test_user.id)},
                "current_period_end": 1740000000,
            },
        })
        resp = client.post("/api/v1/webhooks/stripe", content=json.dumps(event))
        assert resp.status_code == 200
        assert resp.json()["status"] == "processed"

        # User should be Pro now
        me = client.get("/api/v1/auth/me", headers=auth_headers).json()
        assert me["subscription_tier"] == "pro"

    def test_subscription_deleted_downgrades_user(self, client, auth_headers, test_user):
        """Cancellation downgrades user to Free."""
        sub_id = f"sub_{uuid.uuid4().hex}"

        # First create the subscription
        create_event = _make_event("customer.subscription.created", {
            "object": {
                "id": sub_id,
                "metadata": {"user_id": str(test_user.id)},
            },
        })
        client.post("/api/v1/webhooks/stripe", content=json.dumps(create_event))

        # Then delete it
        delete_event = _make_event("customer.subscription.deleted", {
            "object": {
                "id": sub_id,
                "metadata": {"user_id": str(test_user.id)},
            },
        })
        resp = client.post("/api/v1/webhooks/stripe", content=json.dumps(delete_event))
        assert resp.status_code == 200

        # User should be free again
        me = client.get("/api/v1/auth/me", headers=auth_headers).json()
        assert me["subscription_tier"] == "free"
