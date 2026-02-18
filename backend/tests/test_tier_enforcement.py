"""Tier enforcement tests — Free tier 25-item limit.

Per MONETIZATION_AND_LIMITS:
  Free tier: max 25 inventory items
  Pro tier: unlimited
  Soft-deleted items do NOT count against the limit.
"""
import pytest
from app.models.user import User


class TestFreeTierLimit:
    def test_can_create_25_items(self, client, auth_headers):
        """Free tier allows up to 25 items."""
        for i in range(25):
            resp = client.post("/api/v1/inventory", json={"name": f"Item {i}"}, headers=auth_headers)
            assert resp.status_code == 201, f"Failed on item {i}: {resp.json()}"

    def test_26th_item_blocked(self, client, auth_headers):
        """26th item is rejected with 403 and upgrade message."""
        for i in range(25):
            client.post("/api/v1/inventory", json={"name": f"Item {i}"}, headers=auth_headers)

        resp = client.post("/api/v1/inventory", json={"name": "Item 26"}, headers=auth_headers)
        assert resp.status_code == 403
        data = resp.json()["detail"]
        assert data["error"] == "tier_limit_reached"
        assert data["limit"] == 25
        assert data["tier"] == "free"
        assert "Upgrade to Pro" in data["message"]

    def test_soft_deleted_dont_count(self, client, auth_headers):
        """After soft-deleting an item, user can create a new one within limit."""
        # Create 25
        item_ids = []
        for i in range(25):
            resp = client.post("/api/v1/inventory", json={"name": f"Item {i}"}, headers=auth_headers)
            item_ids.append(resp.json()["id"])

        # 26th blocked
        resp = client.post("/api/v1/inventory", json={"name": "Blocked"}, headers=auth_headers)
        assert resp.status_code == 403

        # Delete one
        client.delete(f"/api/v1/inventory/{item_ids[0]}", headers=auth_headers)

        # Now can create again
        resp = client.post("/api/v1/inventory", json={"name": "Replacement"}, headers=auth_headers)
        assert resp.status_code == 201


class TestProTierUnlimited:
    def test_pro_user_no_limit(self, client, db, second_user, second_auth_headers):
        """Pro tier users have no item limit."""
        # Upgrade user to pro
        second_user.subscription_tier = "pro"
        db.flush()

        for i in range(30):
            resp = client.post(
                "/api/v1/inventory",
                json={"name": f"Pro Item {i}"},
                headers=second_auth_headers,
            )
            assert resp.status_code == 201, f"Failed on item {i}: {resp.json()}"
