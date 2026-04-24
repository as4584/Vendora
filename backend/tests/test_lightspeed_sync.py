"""Lightspeed sync service unit tests.

Tests _upsert_inventory_item directly (no HTTP mocking needed) to verify:
  - InventoryExternalLink is created for new items
  - Ledger entries are written for initial quantity (import_adjust)
  - Ledger entries are written on quantity change (sync)
  - No ledger entry is written when quantity is unchanged
  - Legacy items (source/external_id on InventoryItem, no link row) are
    backfilled with an InventoryExternalLink on next sync
  - Soft-deleted linked items return (None, False) — safe skip
  - last_synced_at is stamped on the link row on every call
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.models.inventory import (
    InventoryItem,
    InventoryExternalLink,
    InventoryStockLedger,
)
from app.services.lightspeed import lightspeed_service


# ─── Test data helpers ────────────────────────────────────────────────────────

def _ls_item(
    item_id: str = "1001",
    description: str = "Test Sneaker",
    qty: int = 5,
    price: str = "120.00",
    cost: str = "50.00",
    sku: str = "TSTSNKR",
    category: str = "Footwear",
) -> dict:
    """Minimal Lightspeed Item API payload."""
    return {
        "itemID": item_id,
        "description": description,
        "systemSku": sku,
        "upc": None,
        "qoh": qty,
        "defaultCost": cost,
        "Prices": {
            "ItemPrice": [{"useType": "Default", "amount": price}],
        },
        "Category": {"name": category},
    }


# ─── New-item creation ────────────────────────────────────────────────────────

class TestLightspeedNewItemCreation:
    def test_creates_inventory_item(self, db, test_user):
        item, created = lightspeed_service._upsert_inventory_item(
            db, test_user.id, _ls_item()
        )
        assert created is True
        assert item is not None
        assert item.name == "Test Sneaker"
        assert item.sku == "TSTSNKR"
        assert item.quantity == 5
        assert item.status == "in_stock"
        assert item.source == "lightspeed"
        assert item.external_id == "1001"

    def test_creates_external_link(self, db, test_user):
        item, _ = lightspeed_service._upsert_inventory_item(
            db, test_user.id, _ls_item()
        )
        db.flush()

        link = (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.inventory_item_id == item.id,
                InventoryExternalLink.provider == "lightspeed",
            )
            .first()
        )
        assert link is not None
        assert link.external_id == "1001"
        assert link.external_sku == "TSTSNKR"
        assert link.last_synced_at is not None

    def test_writes_import_adjust_ledger_entry(self, db, test_user):
        item, _ = lightspeed_service._upsert_inventory_item(
            db, test_user.id, _ls_item(qty=7)
        )
        db.flush()

        entries = (
            db.query(InventoryStockLedger)
            .filter(InventoryStockLedger.inventory_item_id == item.id)
            .all()
        )
        assert len(entries) == 1
        assert entries[0].event_type == "import_adjust"
        assert entries[0].delta_quantity == 7
        assert entries[0].quantity_after == 7
        assert entries[0].source_type == "lightspeed"

    def test_zero_quantity_skips_ledger_entry(self, db, test_user):
        item, _ = lightspeed_service._upsert_inventory_item(
            db, test_user.id, _ls_item(qty=0)
        )
        db.flush()

        entries = (
            db.query(InventoryStockLedger)
            .filter(InventoryStockLedger.inventory_item_id == item.id)
            .all()
        )
        assert len(entries) == 0


# ─── Existing-item update (via InventoryExternalLink lookup) ──────────────────

class TestLightspeedExistingItemUpdate:
    def _seed_item_with_link(self, db, user_id, external_id="2001", qty=10):
        """Create an item + external link as if a prior sync ran."""
        item = InventoryItem(
            user_id=user_id,
            name="Old Name",
            sku="OLDSKU",
            quantity=qty,
            status="in_stock",
            source="lightspeed",
            external_id=external_id,
        )
        db.add(item)
        db.flush()
        link = InventoryExternalLink(
            inventory_item_id=item.id,
            user_id=user_id,
            provider="lightspeed",
            external_id=external_id,
            external_sku="OLDSKU",
            last_synced_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        )
        db.add(link)
        db.flush()
        return item, link

    def test_updates_item_fields(self, db, test_user):
        item, _ = self._seed_item_with_link(db, test_user.id)
        lightspeed_service._upsert_inventory_item(
            db, test_user.id,
            _ls_item(item_id="2001", description="New Name", qty=10, sku="NEWSKU"),
        )
        db.flush()
        db.refresh(item)
        assert item.name == "New Name"
        assert item.sku == "NEWSKU"

    def test_quantity_change_writes_sync_ledger_entry(self, db, test_user):
        item, _ = self._seed_item_with_link(db, test_user.id, qty=10)
        lightspeed_service._upsert_inventory_item(
            db, test_user.id,
            _ls_item(item_id="2001", qty=15),
        )
        db.flush()

        entries = (
            db.query(InventoryStockLedger)
            .filter(InventoryStockLedger.inventory_item_id == item.id)
            .all()
        )
        assert len(entries) == 1
        assert entries[0].event_type == "sync"
        assert entries[0].delta_quantity == 5   # 15 - 10
        assert entries[0].quantity_after == 15

    def test_no_quantity_change_no_ledger_entry(self, db, test_user):
        item, _ = self._seed_item_with_link(db, test_user.id, qty=10)
        lightspeed_service._upsert_inventory_item(
            db, test_user.id,
            _ls_item(item_id="2001", qty=10),  # same qty
        )
        db.flush()

        count = (
            db.query(InventoryStockLedger)
            .filter(InventoryStockLedger.inventory_item_id == item.id)
            .count()
        )
        assert count == 0

    def test_stamps_last_synced_at(self, db, test_user):
        before = datetime(2025, 1, 1, tzinfo=timezone.utc)
        item, link = self._seed_item_with_link(db, test_user.id)
        assert link.last_synced_at == before

        lightspeed_service._upsert_inventory_item(
            db, test_user.id, _ls_item(item_id="2001")
        )
        db.flush()
        db.refresh(link)
        assert link.last_synced_at > before

    def test_returns_created_false_for_existing(self, db, test_user):
        self._seed_item_with_link(db, test_user.id)
        _, created = lightspeed_service._upsert_inventory_item(
            db, test_user.id, _ls_item(item_id="2001")
        )
        assert created is False


# ─── Legacy fallback (item with source/external_id, no link row) ──────────────

class TestLightspeedLegacyFallback:
    def _seed_legacy_item(self, db, user_id, external_id="3001", qty=8):
        """Create an item using the old (source, external_id) approach, no link row."""
        item = InventoryItem(
            user_id=user_id,
            name="Legacy Item",
            quantity=qty,
            status="in_stock",
            source="lightspeed",
            external_id=external_id,
        )
        db.add(item)
        db.flush()
        return item

    def test_backfills_external_link(self, db, test_user):
        item = self._seed_legacy_item(db, test_user.id)
        lightspeed_service._upsert_inventory_item(
            db, test_user.id, _ls_item(item_id="3001")
        )
        db.flush()

        link = (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.inventory_item_id == item.id,
                InventoryExternalLink.provider == "lightspeed",
            )
            .first()
        )
        assert link is not None
        assert link.external_id == "3001"

    def test_does_not_duplicate_on_second_sync(self, db, test_user):
        """After backfill, a second sync uses the link row (not the fallback query)."""
        self._seed_legacy_item(db, test_user.id)

        # First sync: backfills link
        lightspeed_service._upsert_inventory_item(
            db, test_user.id, _ls_item(item_id="3001")
        )
        db.flush()

        # Second sync: should hit primary link path
        _, created = lightspeed_service._upsert_inventory_item(
            db, test_user.id, _ls_item(item_id="3001")
        )
        db.flush()
        assert created is False

        link_count = (
            db.query(InventoryExternalLink)
            .filter(InventoryExternalLink.external_id == "3001")
            .count()
        )
        assert link_count == 1  # no duplicate links


# ─── Soft-deleted item handling ───────────────────────────────────────────────

class TestLightspeedSoftDeletedItem:
    def test_returns_none_for_deleted_linked_item(self, db, test_user):
        """If the linked InventoryItem is soft-deleted, sync skips it gracefully."""
        item = InventoryItem(
            user_id=test_user.id,
            name="Deleted Item",
            quantity=5,
            status="in_stock",
            source="lightspeed",
            external_id="9001",
            deleted_at=datetime.now(timezone.utc),  # soft-deleted
        )
        db.add(item)
        db.flush()
        db.add(InventoryExternalLink(
            inventory_item_id=item.id,
            user_id=test_user.id,
            provider="lightspeed",
            external_id="9001",
            last_synced_at=None,
        ))
        db.flush()

        result_item, created = lightspeed_service._upsert_inventory_item(
            db, test_user.id, _ls_item(item_id="9001")
        )
        assert result_item is None
        assert created is False
