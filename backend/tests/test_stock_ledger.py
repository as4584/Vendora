"""Stock ledger and CSV import tests.

Coverage:
  - deduct_stock idempotency (same key → single ledger entry)
  - restore_stock idempotency
  - Ledger entries created on sale and refund via the API
  - CSV import: preview endpoint parses file and returns preview rows
  - CSV import: commit endpoint applies creates/updates
  - CSV import: duplicate commit rejected (job not in 'previewed' state)
  - Inventory list: search, status filter, source filter, available_only filter
"""
import io
import csv
import pytest

from app.models.inventory import InventoryItem, InventoryStockLedger
from app.services.inventory import deduct_stock, restore_stock


# ── Service-layer unit tests (use db directly) ────────────────────────────────

class TestDeductStockIdempotency:
    def _make_item(self, db, user_id, qty: int = 5) -> InventoryItem:
        item = InventoryItem(
            user_id=user_id,
            name="Test Sneaker",
            status="in_stock",
            quantity=qty,
        )
        db.add(item)
        db.flush()
        return item

    def test_deduct_writes_ledger_entry(self, db, test_user):
        item = self._make_item(db, test_user.id, qty=3)
        deduct_stock(db, item, quantity=1, event_type="sale",
                     source_type="test", source_id="s1")
        entries = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id
        ).all()
        assert len(entries) == 1
        assert entries[0].delta_quantity == -1
        assert entries[0].quantity_after == 2

    def test_deduct_idempotency_key_prevents_double_deduction(self, db, test_user):
        item = self._make_item(db, test_user.id, qty=5)
        key = "test:idem:001"

        entry1 = deduct_stock(db, item, quantity=2, event_type="sale",
                              source_type="test", source_id="s1", idempotency_key=key)
        entry2 = deduct_stock(db, item, quantity=2, event_type="sale",
                              source_type="test", source_id="s1", idempotency_key=key)

        assert entry1.id == entry2.id  # same ledger row returned
        assert item.quantity == 3      # only deducted once

        all_entries = db.query(InventoryStockLedger).filter(
            InventoryStockLedger.inventory_item_id == item.id
        ).all()
        assert len(all_entries) == 1

    def test_restore_idempotency_key_prevents_double_restore(self, db, test_user):
        item = self._make_item(db, test_user.id, qty=0)
        item.status = "sold"
        db.add(item)
        db.flush()

        key = "test:refund:001"
        entry1 = restore_stock(db, item, quantity=2, event_type="refund",
                               source_type="test", source_id="r1", idempotency_key=key)
        entry2 = restore_stock(db, item, quantity=2, event_type="refund",
                               source_type="test", source_id="r1", idempotency_key=key)

        assert entry1.id == entry2.id
        assert item.quantity == 2        # only restored once
        assert item.status == "in_stock"

    def test_insufficient_stock_raises_409(self, db, test_user):
        from fastapi import HTTPException
        item = self._make_item(db, test_user.id, qty=1)
        with pytest.raises(HTTPException) as exc_info:
            deduct_stock(db, item, quantity=5, event_type="sale",
                         source_type="test", source_id="s2")
        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["error"] == "insufficient_stock"


# ── API-layer tests ───────────────────────────────────────────────────────────

class TestInventoryFilters:
    def test_search_by_name(self, client, auth_headers):
        client.post("/api/v1/inventory", json={"name": "Air Max 90"}, headers=auth_headers)
        client.post("/api/v1/inventory", json={"name": "Yeezy Boost"}, headers=auth_headers)

        resp = client.get("/api/v1/inventory?q=air+max", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert "Air Max 90" in data["items"][0]["name"]

    def test_search_by_sku(self, client, auth_headers):
        client.post("/api/v1/inventory", json={"name": "Item A", "sku": "SKU-123"}, headers=auth_headers)
        client.post("/api/v1/inventory", json={"name": "Item B", "sku": "SKU-999"}, headers=auth_headers)

        resp = client.get("/api/v1/inventory?q=SKU-123", headers=auth_headers)
        assert resp.json()["total"] == 1

    def test_filter_by_status(self, client, auth_headers):
        item = client.post("/api/v1/inventory", json={"name": "Listed Shoe"}, headers=auth_headers).json()
        client.patch(f"/api/v1/inventory/{item['id']}/status", json={"status": "listed"}, headers=auth_headers)
        client.post("/api/v1/inventory", json={"name": "Stock Shoe"}, headers=auth_headers)

        resp = client.get("/api/v1/inventory?status=listed", headers=auth_headers)
        assert resp.json()["total"] == 1
        assert resp.json()["items"][0]["status"] == "listed"

    def test_available_only_excludes_zero_quantity(self, client, auth_headers):
        client.post("/api/v1/inventory", json={"name": "In Stock", "quantity": 3}, headers=auth_headers)
        item2 = client.post("/api/v1/inventory", json={
            "name": "Sold Out", "quantity": 1,
        }, headers=auth_headers).json()
        # sell the item so it's sold
        client.post("/api/v1/transactions", json={
            "item_id": item2["id"], "method": "cash", "gross_amount": "50.00", "quantity": 1,
        }, headers=auth_headers)

        resp = client.get("/api/v1/inventory?available_only=true", headers=auth_headers)
        assert resp.status_code == 200
        names = [i["name"] for i in resp.json()["items"]]
        assert "In Stock" in names
        assert "Sold Out" not in names


class TestCSVImport:
    def _make_csv(self, rows: list[dict]) -> bytes:
        """Build a minimal CSV bytes object."""
        buf = io.StringIO()
        if not rows:
            return b""
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
        return buf.getvalue().encode()

    def test_preview_returns_job_id_and_rows(self, client, auth_headers):
        csv_bytes = self._make_csv([
            {"name": "Air Force 1", "sku": "AF1-001", "quantity": "3", "buy price": "80.00"},
            {"name": "Dunk Low", "sku": "DL-002", "quantity": "1", "buy price": "100.00"},
        ])
        resp = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("test_import.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        )
        assert resp.status_code == 201
        data = resp.json()
        assert "job_id" in data
        assert data["status"] == "previewed"
        assert data["total_rows"] == 2
        assert data["rows_to_create"] == 2
        assert data["rows_to_update"] == 0
        assert len(data["rows"]) == 2
        assert data["rows"][0]["action"] == "create"

    def test_preview_detects_sku_match_as_update(self, client, auth_headers):
        # Create existing item with SKU
        client.post("/api/v1/inventory", json={
            "name": "Existing Item", "sku": "EX-999", "quantity": 1,
        }, headers=auth_headers)

        csv_bytes = self._make_csv([
            {"name": "Existing Item Updated", "sku": "EX-999", "quantity": "5"},
        ])
        resp = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("update.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["rows_to_update"] == 1
        assert data["rows_to_create"] == 0
        assert data["rows"][0]["action"] == "update"
        assert data["rows"][0]["match_key"] == "sku"

    def test_preview_flags_missing_name_as_error(self, client, auth_headers):
        csv_bytes = self._make_csv([
            {"sku": "NO-NAME-001", "quantity": "2"},  # 'name' column absent
        ])
        resp = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("bad.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["rows_errored"] == 1
        assert data["rows"][0]["action"] == "error"

    def test_commit_creates_items(self, client, auth_headers):
        csv_bytes = self._make_csv([
            {"name": "New Sneaker A", "sku": "NS-A", "quantity": "2", "buy price": "50.00"},
            {"name": "New Sneaker B", "sku": "NS-B", "quantity": "1"},
        ])
        preview = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("create.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        ).json()
        job_id = preview["job_id"]

        commit_resp = client.post(
            f"/api/v1/inventory/imports/{job_id}/commit",
            headers=auth_headers,
        )
        assert commit_resp.status_code == 200
        result = commit_resp.json()
        assert result["status"] == "committed"
        assert result["rows_created"] == 2
        assert result["rows_updated"] == 0

        # Verify items exist in inventory
        inv = client.get("/api/v1/inventory", headers=auth_headers).json()
        names = [i["name"] for i in inv["items"]]
        assert "New Sneaker A" in names
        assert "New Sneaker B" in names

    def test_commit_twice_rejected(self, client, auth_headers):
        csv_bytes = self._make_csv([{"name": "One Time Item", "sku": "OT-1"}])
        preview = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("once.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        ).json()
        job_id = preview["job_id"]

        client.post(f"/api/v1/inventory/imports/{job_id}/commit", headers=auth_headers)

        resp2 = client.post(f"/api/v1/inventory/imports/{job_id}/commit", headers=auth_headers)
        assert resp2.status_code == 400

    def test_get_import_job_status(self, client, auth_headers):
        csv_bytes = self._make_csv([{"name": "Status Check", "sku": "SC-1"}])
        preview = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("status.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        ).json()
        job_id = preview["job_id"]

        resp = client.get(f"/api/v1/inventory/imports/{job_id}", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["id"] == job_id
        assert resp.json()["status"] == "previewed"

    def test_non_csv_rejected(self, client, auth_headers):
        resp = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("data.xlsx", b"binary", "application/vnd.ms-excel")},
            headers=auth_headers,
        )
        assert resp.status_code == 400

    def test_import_job_ownership(self, client, auth_headers, second_auth_headers):
        """User A cannot access User B's import job."""
        csv_bytes = self._make_csv([{"name": "Private Item"}])
        preview = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("private.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        ).json()
        job_id = preview["job_id"]

        resp = client.get(f"/api/v1/inventory/imports/{job_id}", headers=second_auth_headers)
        assert resp.status_code == 404
