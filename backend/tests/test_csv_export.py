"""CSV export tests — Sprint 4.

Tests CSV export for Pro-only gating and content correctness.
"""
import pytest
import csv
import io


class TestCSVExportGating:
    def test_free_user_blocked(self, client, auth_headers):
        """Free users cannot export CSV."""
        resp = client.get("/api/v1/export/inventory", headers=auth_headers)
        assert resp.status_code == 403
        assert resp.json()["detail"]["error"] == "pro_required"

    def test_free_user_transactions_blocked(self, client, auth_headers):
        resp = client.get("/api/v1/export/transactions", headers=auth_headers)
        assert resp.status_code == 403

    def test_unauthenticated(self, client):
        resp = client.get("/api/v1/export/inventory")
        assert resp.status_code == 403


class TestCSVExportContent:
    @pytest.fixture
    def pro_headers(self, client, auth_headers, db, test_user):
        """Upgrade test user to Pro for export tests."""
        test_user.subscription_tier = "pro"
        db.add(test_user)
        db.commit()
        return auth_headers

    def test_inventory_csv(self, client, pro_headers):
        """Pro users can download inventory CSV."""
        # Create items
        client.post("/api/v1/inventory", json={
            "name": "Jordan 1 Chicago",
            "buy_price": "170.00",
            "category": "sneakers",
        }, headers=pro_headers)
        client.post("/api/v1/inventory", json={
            "name": "Yeezy 350 V2",
            "buy_price": "230.00",
        }, headers=pro_headers)

        resp = client.get("/api/v1/export/inventory", headers=pro_headers)
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "text/csv; charset=utf-8"

        # Parse CSV
        reader = csv.reader(io.StringIO(resp.text))
        rows = list(reader)
        assert rows[0][0] == "Name"  # Header
        assert len(rows) == 3  # header + 2 items

    def test_transactions_csv(self, client, pro_headers):
        """Pro users can download transactions CSV."""
        # Create a transaction
        client.post("/api/v1/transactions", json={
            "method": "cash",
            "gross_amount": "100.00",
        }, headers=pro_headers)

        resp = client.get("/api/v1/export/transactions", headers=pro_headers)
        assert resp.status_code == 200

        reader = csv.reader(io.StringIO(resp.text))
        rows = list(reader)
        assert rows[0][0] == "Date"  # Header
        assert len(rows) == 2  # header + 1 transaction

    def test_empty_export(self, client, pro_headers):
        """Empty inventory returns header-only CSV."""
        resp = client.get("/api/v1/export/inventory", headers=pro_headers)
        assert resp.status_code == 200
        reader = csv.reader(io.StringIO(resp.text))
        rows = list(reader)
        assert len(rows) == 1  # header only
