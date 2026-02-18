"""Full regression test suite — Sprint 4.

End-to-end scenarios that test the entire system from registration
through sale, invoice, payment, dashboard, and export.
"""
import json
import uuid

import pytest


class TestFullUserLifecycle:
    """Complete user journey: register → add items → sell → dashboard → export."""

    def test_complete_free_user_journey(self, client):
        """Free user: register → add item → quick sale → dashboard."""
        email = f"lifecycle_{uuid.uuid4().hex[:8]}@test.com"
        password = "StrongPass123!"

        # Register
        user = client.post("/api/v1/auth/register", json={
            "email": email,
            "password": password,
            "business_name": "Test Reseller",
        })
        assert user.status_code == 201

        # Login to get token
        login = client.post("/api/v1/auth/login", json={
            "email": email,
            "password": password,
        })
        assert login.status_code == 200
        token = login.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        # Add item
        item = client.post("/api/v1/inventory", json={
            "name": "Test Sneaker",
            "buy_price": "100.00",
            "expected_sell_price": "200.00",
        }, headers=headers)
        assert item.status_code == 201
        item_id = item.json()["id"]

        # Quick sale
        sale = client.post("/api/v1/transactions", json={
            "item_id": item_id,
            "method": "cash",
            "gross_amount": "200.00",
        }, headers=headers)
        assert sale.status_code == 201

        # Dashboard reflects sale
        dash = client.get("/api/v1/dashboard", headers=headers).json()
        assert float(dash["revenue_today"]) >= 200.0
        assert dash["items_sold"] >= 1

        # Feature flags correct for free tier
        flags = client.get("/api/v1/features", headers=headers).json()
        assert flags["tier"] == "free"
        assert flags["features"]["csv_export"] is False

    def test_pro_user_full_invoice_flow(self, client, auth_headers, db, test_user):
        """Pro user: create item → invoice → pay → sold → export."""
        # Upgrade to pro
        test_user.subscription_tier = "pro"
        db.add(test_user)
        db.commit()

        # Add item
        item = client.post("/api/v1/inventory", json={
            "name": "Invoice Test Item",
            "buy_price": "150.00",
            "expected_sell_price": "300.00",
        }, headers=auth_headers)
        item_id = item.json()["id"]

        # Create invoice
        invoice = client.post("/api/v1/invoices", json={
            "customer_name": "Regression Customer",
            "customer_email": "regression@test.com",
            "items": [{
                "description": "Invoice Test Item",
                "quantity": 1,
                "unit_price": "300.00",
                "inventory_item_id": item_id,
            }],
        }, headers=auth_headers)
        assert invoice.status_code == 201
        inv_id = invoice.json()["id"]

        # Send → Paid
        client.patch(f"/api/v1/invoices/{inv_id}/status",
                     json={"status": "sent"}, headers=auth_headers)
        paid = client.patch(f"/api/v1/invoices/{inv_id}/status",
                            json={"status": "paid"}, headers=auth_headers)
        assert paid.json()["status"] == "paid"

        # Item should be sold
        updated_item = client.get(f"/api/v1/inventory/{item_id}", headers=auth_headers).json()
        assert updated_item["status"] == "sold"

        # Dashboard updated
        dash = client.get("/api/v1/dashboard", headers=auth_headers).json()
        assert dash["items_sold"] >= 1

        # Export works
        csv_resp = client.get("/api/v1/export/inventory", headers=auth_headers)
        assert csv_resp.status_code == 200
        assert "Invoice Test Item" in csv_resp.text


class TestSystemResilience:
    """Tests that verify error handling and edge cases."""

    def test_health_check(self, client):
        resp = client.get("/api/v1/health")
        assert resp.status_code == 200
        assert resp.json()["version"] == "4.0.0"

    def test_invalid_json(self, client, auth_headers):
        resp = client.post(
            "/api/v1/inventory",
            content=b"not json",
            headers={**auth_headers, "Content-Type": "application/json"},
        )
        assert resp.status_code == 422

    def test_missing_required_fields(self, client, auth_headers):
        resp = client.post("/api/v1/inventory", json={}, headers=auth_headers)
        assert resp.status_code == 422

    def test_pagination_edge_cases(self, client, auth_headers):
        resp = client.get("/api/v1/inventory?page=999", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["items"] == []

    def test_expired_token_rejected(self, client):
        headers = {"Authorization": "Bearer invalid.token.here"}
        resp = client.get("/api/v1/inventory", headers=headers)
        assert resp.status_code in [401, 403]
