"""Dashboard endpoint tests — /api/v1/dashboard

Coverage: empty dashboard, after sales, after refunds, inventory valuation.
"""
import pytest


SAMPLE_ITEM = {
    "name": "Jordan 1 Retro High OG",
    "category": "sneakers",
    "buy_price": "120.00",
    "expected_sell_price": "250.00",
}


class TestDashboardEmpty:
    def test_empty_dashboard(self, client, auth_headers):
        """New user sees all zeros."""
        resp = client.get("/api/v1/dashboard", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["revenue_today"] == "0.00"
        assert data["net_profit_all_time"] == "0.00"
        assert data["total_items"] == 0
        assert data["total_transactions"] == 0


class TestDashboardWithSales:
    def test_revenue_after_sale(self, client, auth_headers):
        """Revenue reflects completed transactions."""
        client.post("/api/v1/transactions", json={
            "method": "cash", "gross_amount": "100.00",
        }, headers=auth_headers)
        client.post("/api/v1/transactions", json={
            "method": "venmo", "gross_amount": "50.00", "fee_amount": "1.00",
        }, headers=auth_headers)

        dashboard = client.get("/api/v1/dashboard", headers=auth_headers).json()
        assert dashboard["revenue_today"] == "150.00"
        assert dashboard["total_transactions"] == 2

    def test_inventory_counts(self, client, auth_headers):
        """Item counts reflect current status distribution."""
        # Create items
        items = []
        for i in range(3):
            resp = client.post("/api/v1/inventory", json={
                "name": f"Item {i}", "buy_price": "50.00", "expected_sell_price": "100.00",
            }, headers=auth_headers)
            items.append(resp.json())

        # Move one to listed
        client.patch(f"/api/v1/inventory/{items[0]['id']}/status",
                     json={"status": "listed"}, headers=auth_headers)
        # Quick sale one
        client.post("/api/v1/transactions", json={
            "item_id": items[1]["id"], "method": "cash", "gross_amount": "100.00",
        }, headers=auth_headers)

        dashboard = client.get("/api/v1/dashboard", headers=auth_headers).json()
        assert dashboard["total_items"] == 3
        assert dashboard["items_in_stock"] == 1
        assert dashboard["items_listed"] == 1
        assert dashboard["items_sold"] == 1

    def test_inventory_value(self, client, auth_headers):
        """Inventory value only counts active (in_stock + listed) items."""
        # 2 in-stock items
        for i in range(2):
            client.post("/api/v1/inventory", json={
                "name": f"Item {i}", "buy_price": "100.00", "expected_sell_price": "200.00",
            }, headers=auth_headers)

        dashboard = client.get("/api/v1/dashboard", headers=auth_headers).json()
        assert dashboard["total_inventory_value"] == "200.00"
        assert dashboard["total_expected_value"] == "400.00"
        assert dashboard["potential_profit"] == "200.00"


class TestDashboardWithRefunds:
    def test_refund_adjusts_revenue(self, client, auth_headers):
        """Refund reduces revenue figure."""
        # Sale
        txn = client.post("/api/v1/transactions", json={
            "method": "cash", "gross_amount": "200.00",
        }, headers=auth_headers).json()

        # Another sale
        client.post("/api/v1/transactions", json={
            "method": "cash", "gross_amount": "100.00",
        }, headers=auth_headers)

        # Refund first sale
        client.post(f"/api/v1/transactions/{txn['id']}/refund", json={}, headers=auth_headers)

        dashboard = client.get("/api/v1/dashboard", headers=auth_headers).json()
        # Revenue: 200 + 100 = 300 gross, minus 200 refund = 100
        assert dashboard["revenue_today"] == "100.00"
        assert dashboard["total_refunds"] == 1

    def test_unauthenticated(self, client):
        resp = client.get("/api/v1/dashboard")
        assert resp.status_code == 403
