"""Public seller page tests — Sprint 4.

Tests seller page access, Partner gating, and content.
"""
import pytest


class TestPublicSellerPage:
    def test_non_partner_blocked(self, client, test_user):
        """Non-partner users don't have public pages."""
        resp = client.get(f"/api/v1/sellers/{test_user.id}")
        assert resp.status_code == 404

    def test_partner_page_visible(self, client, db, test_user, auth_headers):
        """Partner users have public pages with stats."""
        # Upgrade to partner
        test_user.subscription_tier = "pro"
        test_user.is_partner = True
        test_user.business_name = "Lex's Kicks"
        db.add(test_user)
        db.commit()

        resp = client.get(f"/api/v1/sellers/{test_user.id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["seller"]["business_name"] == "Lex's Kicks"
        assert data["seller"]["verified"] is True
        assert data["disclaimer"]  # Must include disclaimer
        assert "guarantee" not in data["disclaimer"].lower() or "does not guarantee" in data["disclaimer"].lower()

    def test_partner_page_shows_listings(self, client, db, test_user, auth_headers):
        """Seller page shows active listings."""
        test_user.subscription_tier = "pro"
        test_user.is_partner = True
        db.add(test_user)
        db.commit()

        # Add some items
        client.post("/api/v1/inventory", json={
            "name": "Air Max 90",
            "expected_sell_price": "120.00",
        }, headers=auth_headers)
        client.post("/api/v1/inventory", json={
            "name": "Dunk Low Panda",
            "expected_sell_price": "150.00",
        }, headers=auth_headers)

        resp = client.get(f"/api/v1/sellers/{test_user.id}")
        assert len(resp.json()["listings"]) == 2

    def test_no_auth_required(self, client, db, test_user):
        """Seller page is public — no auth header needed."""
        test_user.subscription_tier = "pro"
        test_user.is_partner = True
        db.add(test_user)
        db.commit()

        resp = client.get(f"/api/v1/sellers/{test_user.id}")
        assert resp.status_code == 200  # No auth headers sent

    def test_nonexistent_seller(self, client):
        import uuid
        resp = client.get(f"/api/v1/sellers/{uuid.uuid4()}")
        assert resp.status_code == 404
