"""Feature flags tests — Sprint 4.

Tests feature flag service and endpoint.
"""
import pytest


class TestFeatureFlagService:
    """Unit tests for the feature flags service."""

    def test_free_tier_flags(self):
        from app.services.feature_flags import get_feature_flags
        flags = get_feature_flags("free")
        assert flags["inventory_crud"] is True
        assert flags["manual_payment"] is True
        assert flags["dashboard_basic"] is True
        assert flags["barcode_scanning"] is False
        assert flags["csv_export"] is False
        assert flags["invoices"] is False
        assert flags["stripe_payments"] is False
        assert flags["seller_page"] is False

    def test_pro_tier_flags(self):
        from app.services.feature_flags import get_feature_flags
        flags = get_feature_flags("pro")
        assert flags["inventory_crud"] is True
        assert flags["barcode_scanning"] is True
        assert flags["csv_export"] is True
        assert flags["invoices"] is True
        assert flags["stripe_payments"] is True
        assert flags["seller_page"] is False  # requires partner

    def test_pro_partner_flags(self):
        from app.services.feature_flags import get_feature_flags
        flags = get_feature_flags("pro", is_partner=True)
        assert flags["seller_page"] is True
        assert flags["verified_badge"] is True
        assert flags["barcode_scanning"] is True

    def test_is_feature_enabled(self):
        from app.services.feature_flags import is_feature_enabled
        assert is_feature_enabled("csv_export", "pro") is True
        assert is_feature_enabled("csv_export", "free") is False
        assert is_feature_enabled("nonexistent", "pro") is False

    def test_get_tier_info(self):
        from app.services.feature_flags import get_tier_info
        free = get_tier_info("free")
        assert free["price"] == 0
        assert free["item_limit"] == 25

        pro = get_tier_info("pro")
        assert pro["price"] == 20
        assert pro["item_limit"] is None


class TestFeatureFlagEndpoint:
    def test_free_user_gets_flags(self, client, auth_headers):
        resp = client.get("/api/v1/features", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["tier"] == "free"
        assert data["features"]["barcode_scanning"] is False
        assert data["features"]["inventory_crud"] is True

    def test_tiers_endpoint(self, client, auth_headers):
        resp = client.get("/api/v1/features/tiers", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["tiers"]["free"]["price"] == 0
        assert data["tiers"]["pro"]["price"] == 20
        assert data["partner_addon"]["price"] == 5
