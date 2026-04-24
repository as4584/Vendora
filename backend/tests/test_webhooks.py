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


class TestWebhookStockDeduction:
    """Integration tests: Stripe webhook → process_invoice_payment → deduct_stock.

    Covers the full chain:
      webhook event → WebhookEvent dedup check → handle_payment_intent_succeeded
      → transition_invoice(paid) → process_invoice_payment
      → deduct_stock (idempotency key) → InventoryStockLedger entry written
    """

    def _fire_paid_webhook(self, client, auth_headers, quantity=1, item_qty=5):
        """Helper: create item, create+send invoice, fire webhook, return state."""
        item = client.post("/api/v1/inventory", json={
            "name": "Webhook Stock Item",
            "buy_price": "50.00",
            "quantity": item_qty,
        }, headers=auth_headers).json()

        invoice = client.post("/api/v1/invoices", json={
            "customer_name": "Webhook Buyer",
            "items": [{
                "description": "Webhook Stock Item",
                "quantity": quantity,
                "unit_price": "120.00",
                "inventory_item_id": item["id"],
            }],
        }, headers=auth_headers).json()

        client.patch(
            f"/api/v1/invoices/{invoice['id']}/status",
            json={"status": "sent"},
            headers=auth_headers,
        )

        pi_id = f"pi_{uuid.uuid4().hex}"
        event = _make_event("payment_intent.succeeded", {
            "object": {
                "id": pi_id,
                "metadata": {"invoice_id": str(invoice["id"]), "user_id": "any"},
            },
        })
        resp = client.post("/api/v1/webhooks/stripe", content=json.dumps(event))
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "processed"

        return item, invoice, event

    def test_webhook_deducts_stock_and_writes_ledger(self, client, auth_headers, db):
        """Webhook fires deduct_stock; a ledger entry is written with correct delta."""
        from app.models.inventory import InventoryStockLedger
        import uuid as _uuid

        item, invoice, _ = self._fire_paid_webhook(
            client, auth_headers, quantity=2, item_qty=5
        )

        entries = (
            db.query(InventoryStockLedger)
            .filter(InventoryStockLedger.inventory_item_id == _uuid.UUID(item["id"]))
            .all()
        )
        assert len(entries) == 1
        assert entries[0].delta_quantity == -2
        assert entries[0].quantity_after == 3
        assert entries[0].event_type == "sale"
        assert entries[0].source_type == "invoice"
        assert entries[0].idempotency_key is not None

    def test_webhook_sets_actual_sell_price(self, client, auth_headers):
        """After webhook, item.actual_sell_price equals invoice line unit_price."""
        item, _, _ = self._fire_paid_webhook(client, auth_headers)

        updated_item = client.get(
            f"/api/v1/inventory/{item['id']}", headers=auth_headers
        ).json()
        assert updated_item["actual_sell_price"] == "120.00"

    def test_webhook_links_transaction_to_invoice(self, client, auth_headers, db):
        """Transaction created by process_invoice_payment has invoice_id set."""
        from app.models.transaction import Transaction
        import uuid as _uuid

        item, invoice, _ = self._fire_paid_webhook(client, auth_headers)

        txn = (
            db.query(Transaction)
            .filter(Transaction.invoice_id == _uuid.UUID(invoice["id"]))
            .first()
        )
        assert txn is not None
        assert txn.status == "completed"
        assert txn.quantity == 1
        assert txn.is_refund is False

    def test_webhook_replay_is_idempotent(self, client, auth_headers, db):
        """Re-sending the same event deduplicates at webhook layer; stock is not double-deducted."""
        from app.models.inventory import InventoryStockLedger
        import uuid as _uuid

        item, _, event = self._fire_paid_webhook(
            client, auth_headers, quantity=1, item_qty=3
        )

        # Replay the identical event
        resp2 = client.post("/api/v1/webhooks/stripe", content=json.dumps(event))
        assert resp2.status_code == 200
        assert resp2.json()["status"] == "already_processed"

        # Exactly one ledger entry, quantity deducted only once
        entries = (
            db.query(InventoryStockLedger)
            .filter(InventoryStockLedger.inventory_item_id == _uuid.UUID(item["id"]))
            .all()
        )
        assert len(entries) == 1

        updated_item = client.get(
            f"/api/v1/inventory/{item['id']}", headers=auth_headers
        ).json()
        assert updated_item["quantity"] == 2  # 3 - 1, not 1

    def test_webhook_full_deduction_transitions_item_to_sold(self, client, auth_headers):
        """When the deduction exhausts stock, item.status becomes 'sold'."""
        item, _, _ = self._fire_paid_webhook(
            client, auth_headers, quantity=3, item_qty=3
        )

        updated_item = client.get(
            f"/api/v1/inventory/{item['id']}", headers=auth_headers
        ).json()
        assert updated_item["status"] == "sold"
        assert updated_item["quantity"] == 0

    def test_webhook_stock_idempotency_key_prevents_double_deduction(
        self, client, auth_headers, db
    ):
        """Calling process_invoice_payment twice with the same invoice uses idempotency key.

        This simulates a race between two concurrent webhook deliveries that both
        slip through the WebhookEvent dedup (different event IDs, same invoice).
        """
        from app.models.inventory import InventoryStockLedger
        from app.services.invoice import process_invoice_payment
        from app.models.invoice import Invoice
        import uuid as _uuid

        item, invoice, _ = self._fire_paid_webhook(
            client, auth_headers, quantity=2, item_qty=10
        )

        # Simulate a second call to process_invoice_payment (already paid invoice)
        inv_obj = db.query(Invoice).filter(
            Invoice.id == _uuid.UUID(invoice["id"])
        ).first()
        process_invoice_payment(inv_obj, db)

        # Only one ledger entry despite two calls
        entries = (
            db.query(InventoryStockLedger)
            .filter(InventoryStockLedger.inventory_item_id == _uuid.UUID(item["id"]))
            .all()
        )
        assert len(entries) == 1
        assert entries[0].delta_quantity == -2
        assert entries[0].quantity_after == 8


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
