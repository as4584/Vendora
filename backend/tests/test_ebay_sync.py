"""eBay integration unit tests.

Covers the eBay-specific logic:
  - OAuth signed-state round trip + tamper rejection
  - Sandbox/production host switching
  - authorization_url uses the RuName as redirect_uri
  - _upsert_inventory_item: create + link + ledger, update + qty-change ledger,
    soft-deleted link safe-skip, SKU-keyed external link
  - _upsert_transaction: create + idempotent update
"""
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.inventory import (
    InventoryItem,
    InventoryExternalLink,
    InventoryStockLedger,
)
from app.models.transaction import Transaction
from app.services.ebay import EbayService, ebay_service


# ─── OAuth state ────────────────────────────────────────────────────────────────

class TestEbayOAuthState:
    def test_signed_state_round_trip(self):
        user_id = uuid.uuid4()
        state = ebay_service.build_state(user_id)
        assert ebay_service.parse_state(state) == user_id

    def test_tampered_state_is_rejected(self):
        state = ebay_service.build_state(uuid.uuid4())
        header, payload, signature = state.split(".")
        replacement = "a" if signature[0] != "a" else "b"
        tampered = ".".join((header, payload, replacement + signature[1:]))
        with pytest.raises(HTTPException) as exc:
            ebay_service.parse_state(tampered)
        assert exc.value.status_code == 400

    def test_wrong_purpose_state_is_rejected(self):
        # A Lightspeed-style state (different purpose) must not validate for eBay.
        from app.services.lightspeed import lightspeed_service
        ls_state = lightspeed_service.build_state(uuid.uuid4())
        with pytest.raises(HTTPException):
            ebay_service.parse_state(ls_state)


# ─── Environment host switching ──────────────────────────────────────────────────

class TestEbayEnvironment:
    def test_sandbox_hosts(self):
        svc = EbayService()
        svc.env = "sandbox"
        assert "auth.sandbox.ebay.com" in svc.auth_url
        assert "api.sandbox.ebay.com" in svc.token_url
        assert "api.sandbox.ebay.com" in svc.api_base
        assert "apiz.sandbox.ebay.com" in svc.identity_base

    def test_production_hosts(self):
        svc = EbayService()
        svc.env = "production"
        assert svc.auth_url == "https://auth.ebay.com/oauth2/authorize"
        assert "api.ebay.com/identity" in svc.token_url
        assert svc.api_base == "https://api.ebay.com"
        assert svc.identity_base == "https://apiz.ebay.com"

    def test_authorization_url_uses_runame_as_redirect(self):
        svc = EbayService()
        svc.client_id = "app-id"
        svc.client_secret = "cert-id"
        svc.runame = "My-RuName-123"
        svc.env = "sandbox"
        url = svc.authorization_url(state="xyz")
        assert "client_id=app-id" in url
        assert "redirect_uri=My-RuName-123" in url
        assert "state=xyz" in url
        assert "sell.inventory.readonly" in url

    def test_unconfigured_raises_503(self):
        svc = EbayService()
        svc.client_id = ""
        svc.client_secret = ""
        svc.runame = ""
        with pytest.raises(HTTPException) as exc:
            svc.authorization_url(state="xyz")
        assert exc.value.status_code == 503


# ─── Test data helper ─────────────────────────────────────────────────────────────

def _eb_item(
    sku: str = "TSTSNKR",
    title: str = "Test Sneaker",
    qty: int = 5,
    image: str = "https://img.ebay.com/1.jpg",
    upc: str = "012345678905",
) -> dict:
    """Minimal eBay Inventory API inventory_item payload."""
    return {
        "sku": sku,
        "product": {"title": title, "imageUrls": [image], "upc": [upc]},
        "condition": "NEW",
        "availability": {"shipToLocationAvailability": {"quantity": qty}},
    }


# ─── Inventory upsert ───────────────────────────────────────────────────────────

class TestEbayNewItemCreation:
    def test_creates_inventory_item(self, db, test_user):
        item, created = ebay_service._upsert_inventory_item(
            db, test_user.id, _eb_item(), Decimal("120.00")
        )
        assert created is True
        assert item is not None
        assert item.name == "Test Sneaker"
        assert item.sku == "TSTSNKR"
        assert item.quantity == 5
        assert item.status == "listed"
        assert item.source == "ebay"
        assert item.external_id == "TSTSNKR"
        assert item.expected_sell_price == Decimal("120.00")
        assert item.photo_front_url == "https://img.ebay.com/1.jpg"

    def test_creates_external_link_keyed_by_sku(self, db, test_user):
        item, _ = ebay_service._upsert_inventory_item(
            db, test_user.id, _eb_item(), Decimal("120.00")
        )
        db.flush()
        link = (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.inventory_item_id == item.id,
                InventoryExternalLink.provider == "ebay",
            )
            .first()
        )
        assert link is not None
        assert link.external_id == "TSTSNKR"
        assert link.last_synced_at is not None

    def test_writes_import_adjust_ledger_entry(self, db, test_user):
        item, _ = ebay_service._upsert_inventory_item(
            db, test_user.id, _eb_item(qty=3), Decimal("50.00")
        )
        db.flush()
        ledger = (
            db.query(InventoryStockLedger)
            .filter(InventoryStockLedger.inventory_item_id == item.id)
            .all()
        )
        assert len(ledger) == 1
        assert ledger[0].event_type == "import_adjust"
        assert ledger[0].delta_quantity == 3
        assert ledger[0].source_type == "ebay"

    def test_missing_sku_is_skipped(self, db, test_user):
        item, created = ebay_service._upsert_inventory_item(
            db, test_user.id, {"product": {"title": "No SKU"}}, None
        )
        assert item is None and created is False


class TestEbayItemUpdate:
    def test_quantity_change_writes_sync_ledger(self, db, test_user):
        item, _ = ebay_service._upsert_inventory_item(
            db, test_user.id, _eb_item(qty=5), Decimal("120.00")
        )
        db.flush()
        item2, created = ebay_service._upsert_inventory_item(
            db, test_user.id, _eb_item(qty=2), Decimal("120.00")
        )
        db.flush()
        assert created is False
        assert item2.id == item.id
        assert item2.quantity == 2
        ledger = (
            db.query(InventoryStockLedger)
            .filter(
                InventoryStockLedger.inventory_item_id == item.id,
                InventoryStockLedger.event_type == "sync",
            )
            .all()
        )
        assert len(ledger) == 1
        assert ledger[0].delta_quantity == -3

    def test_unchanged_quantity_writes_no_sync_ledger(self, db, test_user):
        item, _ = ebay_service._upsert_inventory_item(
            db, test_user.id, _eb_item(qty=5), Decimal("120.00")
        )
        db.flush()
        ebay_service._upsert_inventory_item(
            db, test_user.id, _eb_item(qty=5), Decimal("120.00")
        )
        db.flush()
        sync_entries = (
            db.query(InventoryStockLedger)
            .filter(
                InventoryStockLedger.inventory_item_id == item.id,
                InventoryStockLedger.event_type == "sync",
            )
            .count()
        )
        assert sync_entries == 0

    def test_soft_deleted_link_is_skipped(self, db, test_user):
        item, _ = ebay_service._upsert_inventory_item(
            db, test_user.id, _eb_item(), Decimal("120.00")
        )
        db.flush()
        item.deleted_at = datetime.now(timezone.utc)
        db.add(item)
        db.flush()
        result, created = ebay_service._upsert_inventory_item(
            db, test_user.id, _eb_item(), Decimal("120.00")
        )
        assert result is None and created is False


# ─── Transaction upsert ─────────────────────────────────────────────────────────

class TestEbayTransactionUpsert:
    @staticmethod
    def _order(order_id: str = "12-09999", total: str = "29.99") -> dict:
        return {"orderId": order_id, "pricingSummary": {"total": {"value": total, "currency": "USD"}}}

    def test_creates_transaction(self, db, test_user):
        txn, created = ebay_service._upsert_transaction(db, test_user.id, self._order())
        db.flush()
        assert created is True
        assert txn.source == "ebay"
        assert txn.gross_amount == Decimal("29.99")
        assert txn.net_amount == Decimal("29.99")
        assert txn.external_reference_id == "12-09999"

    def test_upsert_is_idempotent(self, db, test_user):
        ebay_service._upsert_transaction(db, test_user.id, self._order())
        db.flush()
        _, created = ebay_service._upsert_transaction(
            db, test_user.id, self._order(total="35.00")
        )
        db.flush()
        assert created is False
        count = (
            db.query(Transaction)
            .filter(
                Transaction.user_id == test_user.id,
                Transaction.source == "ebay",
                Transaction.external_reference_id == "12-09999",
            )
            .count()
        )
        assert count == 1
