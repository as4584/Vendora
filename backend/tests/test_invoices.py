"""Invoice endpoint tests — /api/v1/invoices

Coverage: CRUD, state machine, payment processing, ownership.
"""
import pytest


SAMPLE_ITEM = {
    "name": "Jordan 4 Military Black",
    "category": "sneakers",
    "buy_price": "190.00",
    "expected_sell_price": "350.00",
}


class TestCreateInvoice:
    def test_create_basic_invoice(self, client, auth_headers):
        """Create invoice with line items."""
        resp = client.post("/api/v1/invoices", json={
            "customer_name": "John Doe",
            "customer_email": "john@example.com",
            "items": [
                {"description": "Jordan 4 Military Black", "quantity": 1, "unit_price": "350.00"},
            ],
        }, headers=auth_headers)
        assert resp.status_code == 201
        data = resp.json()
        assert data["customer_name"] == "John Doe"
        assert data["status"] == "draft"
        assert data["subtotal"] == "350.00"
        assert data["total"] == "350.00"
        assert len(data["items"]) == 1
        assert data["items"][0]["line_total"] == "350.00"

    def test_create_invoice_with_tax_shipping(self, client, auth_headers):
        """Tax + shipping applied to total."""
        resp = client.post("/api/v1/invoices", json={
            "customer_name": "Jane Smith",
            "items": [
                {"description": "Item A", "quantity": 2, "unit_price": "100.00"},
                {"description": "Item B", "quantity": 1, "unit_price": "50.00"},
            ],
            "tax": "15.00",
            "shipping": "10.00",
            "discount": "25.00",
        }, headers=auth_headers)
        assert resp.status_code == 201
        data = resp.json()
        assert data["subtotal"] == "250.00"  # 200 + 50
        assert data["total"] == "250.00"  # 250 + 15 + 10 - 25

    def test_create_invoice_with_inventory_link(self, client, auth_headers):
        """Link invoice line items to inventory."""
        item = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers).json()

        resp = client.post("/api/v1/invoices", json={
            "customer_name": "Buyer",
            "items": [
                {
                    "description": SAMPLE_ITEM["name"],
                    "quantity": 1,
                    "unit_price": "350.00",
                    "inventory_item_id": item["id"],
                },
            ],
        }, headers=auth_headers)
        assert resp.status_code == 201
        assert resp.json()["items"][0]["inventory_item_id"] == item["id"]

    def test_create_invoice_no_items_rejected(self, client, auth_headers):
        """At least one line item required."""
        resp = client.post("/api/v1/invoices", json={
            "customer_name": "Nobody",
            "items": [],
        }, headers=auth_headers)
        assert resp.status_code == 422

    def test_unauthenticated(self, client):
        resp = client.post("/api/v1/invoices", json={
            "customer_name": "Test",
            "items": [{"description": "X", "quantity": 1, "unit_price": "10.00"}],
        })
        assert resp.status_code == 403


class TestListInvoices:
    def test_list_empty(self, client, auth_headers):
        resp = client.get("/api/v1/invoices", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["total"] == 0

    def test_list_with_invoices(self, client, auth_headers):
        for i in range(3):
            client.post("/api/v1/invoices", json={
                "customer_name": f"Customer {i}",
                "items": [{"description": f"Item {i}", "quantity": 1, "unit_price": "50.00"}],
            }, headers=auth_headers)

        resp = client.get("/api/v1/invoices", headers=auth_headers)
        assert resp.json()["total"] == 3

    def test_ownership_isolation(self, client, auth_headers, second_auth_headers):
        client.post("/api/v1/invoices", json={
            "customer_name": "User A Customer",
            "items": [{"description": "A item", "quantity": 1, "unit_price": "100.00"}],
        }, headers=auth_headers)
        client.post("/api/v1/invoices", json={
            "customer_name": "User B Customer",
            "items": [{"description": "B item", "quantity": 1, "unit_price": "200.00"}],
        }, headers=second_auth_headers)

        assert client.get("/api/v1/invoices", headers=auth_headers).json()["total"] == 1
        assert client.get("/api/v1/invoices", headers=second_auth_headers).json()["total"] == 1


class TestInvoiceStateMachine:
    def _create_invoice(self, client, auth_headers):
        return client.post("/api/v1/invoices", json={
            "customer_name": "State Test",
            "items": [{"description": "Test Item", "quantity": 1, "unit_price": "100.00"}],
        }, headers=auth_headers).json()

    def test_draft_to_sent(self, client, auth_headers):
        inv = self._create_invoice(client, auth_headers)
        resp = client.patch(f"/api/v1/invoices/{inv['id']}/status",
                            json={"status": "sent"}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["status"] == "sent"

    def test_sent_to_paid(self, client, auth_headers):
        inv = self._create_invoice(client, auth_headers)
        client.patch(f"/api/v1/invoices/{inv['id']}/status",
                     json={"status": "sent"}, headers=auth_headers)
        resp = client.patch(f"/api/v1/invoices/{inv['id']}/status",
                            json={"status": "paid"}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["status"] == "paid"

    def test_sent_to_cancelled(self, client, auth_headers):
        inv = self._create_invoice(client, auth_headers)
        client.patch(f"/api/v1/invoices/{inv['id']}/status",
                     json={"status": "sent"}, headers=auth_headers)
        resp = client.patch(f"/api/v1/invoices/{inv['id']}/status",
                            json={"status": "cancelled"}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"

    def test_paid_is_locked(self, client, auth_headers):
        """Paid invoices cannot be edited (STATE_MACHINES.md)."""
        inv = self._create_invoice(client, auth_headers)
        client.patch(f"/api/v1/invoices/{inv['id']}/status",
                     json={"status": "sent"}, headers=auth_headers)
        client.patch(f"/api/v1/invoices/{inv['id']}/status",
                     json={"status": "paid"}, headers=auth_headers)

        # Try to cancel a paid invoice
        resp = client.patch(f"/api/v1/invoices/{inv['id']}/status",
                            json={"status": "cancelled"}, headers=auth_headers)
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"] == "invalid_transition"

    def test_cancelled_cannot_be_paid(self, client, auth_headers):
        """Cancelled invoices cannot be paid (STATE_MACHINES.md)."""
        inv = self._create_invoice(client, auth_headers)
        client.patch(f"/api/v1/invoices/{inv['id']}/status",
                     json={"status": "sent"}, headers=auth_headers)
        client.patch(f"/api/v1/invoices/{inv['id']}/status",
                     json={"status": "cancelled"}, headers=auth_headers)

        resp = client.patch(f"/api/v1/invoices/{inv['id']}/status",
                            json={"status": "paid"}, headers=auth_headers)
        assert resp.status_code == 400

    def test_invalid_status(self, client, auth_headers):
        inv = self._create_invoice(client, auth_headers)
        resp = client.patch(f"/api/v1/invoices/{inv['id']}/status",
                            json={"status": "refunded"}, headers=auth_headers)
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"] == "invalid_status"

    def test_skip_status(self, client, auth_headers):
        """Cannot skip from draft directly to paid."""
        inv = self._create_invoice(client, auth_headers)
        resp = client.patch(f"/api/v1/invoices/{inv['id']}/status",
                            json={"status": "paid"}, headers=auth_headers)
        assert resp.status_code == 400


class TestInvoicePaymentProcessing:
    def test_paid_creates_transactions(self, client, auth_headers):
        """When invoice is marked paid, transactions are created for each line item."""
        # Create invoice with 2 items
        resp = client.post("/api/v1/invoices", json={
            "customer_name": "Paying Customer",
            "items": [
                {"description": "Item A", "quantity": 1, "unit_price": "100.00"},
                {"description": "Item B", "quantity": 1, "unit_price": "150.00"},
            ],
        }, headers=auth_headers)
        inv_id = resp.json()["id"]

        # Transition: draft → sent → paid
        client.patch(f"/api/v1/invoices/{inv_id}/status",
                     json={"status": "sent"}, headers=auth_headers)
        client.patch(f"/api/v1/invoices/{inv_id}/status",
                     json={"status": "paid"}, headers=auth_headers)

        # Verify transactions were created
        txns = client.get("/api/v1/transactions", headers=auth_headers).json()
        assert txns["total"] == 2

    def test_paid_transitions_inventory_to_sold(self, client, auth_headers):
        """When invoice is paid, linked inventory items transition to sold."""
        item = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers).json()

        resp = client.post("/api/v1/invoices", json={
            "customer_name": "Buyer",
            "items": [{
                "description": SAMPLE_ITEM["name"],
                "quantity": 1,
                "unit_price": "350.00",
                "inventory_item_id": item["id"],
            }],
        }, headers=auth_headers)
        inv_id = resp.json()["id"]

        client.patch(f"/api/v1/invoices/{inv_id}/status",
                     json={"status": "sent"}, headers=auth_headers)
        client.patch(f"/api/v1/invoices/{inv_id}/status",
                     json={"status": "paid"}, headers=auth_headers)

        # Item should now be sold
        updated = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
        assert updated["status"] == "sold"
        assert updated["actual_sell_price"] == "350.00"
