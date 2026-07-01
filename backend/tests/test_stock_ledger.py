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
from datetime import datetime, timezone

from app.models.inventory import InventoryItem, InventoryStockLedger, InventoryImportJob, InventoryImportRow
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

    def test_filter_by_source(self, client, auth_headers, db, test_user):
        """source= param only returns items with that source value."""
        from app.models.inventory import InventoryItem as _Item
        # Create one manual and one lightspeed-sourced item directly in DB.
        ls_item = _Item(
            user_id=test_user.id, name="LS Shoe", source="lightspeed",
            status="in_stock", quantity=1,
        )
        manual_item = _Item(
            user_id=test_user.id, name="Manual Shoe", source=None,
            status="in_stock", quantity=1,
        )
        db.add_all([ls_item, manual_item])
        db.flush()

        resp = client.get("/api/v1/inventory?source=lightspeed", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert data["items"][0]["name"] == "LS Shoe"
        assert data["items"][0]["source"] == "lightspeed"


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

    def test_preview_detects_id_match_for_sku_less_item(self, client, auth_headers):
        """Re-importing an exported CSV matches items without SKU by their id column."""
        # Create an item with no SKU so it can only be matched by id.
        create_resp = client.post(
            "/api/v1/inventory",
            json={"name": "No SKU Bag", "quantity": 1, "buy_price": "50.00"},
            headers=auth_headers,
        )
        assert create_resp.status_code == 201
        item_id = create_resp.json()["id"]

        # Build a CSV that looks like an export (includes 'id' column, no sku).
        csv_bytes = self._make_csv([
            {"id": item_id, "name": "No SKU Bag", "quantity": "3", "buy price": "50.00"},
        ])
        resp = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("round_trip.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["rows_to_update"] == 1, "Should match by id, not create a duplicate"
        assert data["rows_to_create"] == 0
        row = data["rows"][0]
        assert row["action"] == "update"
        assert row["match_key"] == "id"
        assert row["inventory_item_id"] == item_id


class TestImportCommitEdgeCases:
    def test_missing_commit_job_returns_404(self, client, auth_headers):
        resp = client.post(
            "/api/v1/inventory/imports/00000000-0000-0000-0000-000000000000/commit",
            headers=auth_headers,
        )
        assert resp.status_code == 404

    def test_commit_applies_update_and_skips_invalid_rows(self, client, auth_headers, db, test_user):
        active = InventoryItem(user_id=test_user.id, name="Old", quantity=2, status="in_stock")
        unchanged = InventoryItem(user_id=test_user.id, name="Stable", quantity=4, status="in_stock")
        deleted = InventoryItem(
            user_id=test_user.id,
            name="Deleted",
            quantity=1,
            status="in_stock",
            deleted_at=datetime.now(timezone.utc),
        )
        db.add_all([active, unchanged, deleted])
        db.flush()
        job = InventoryImportJob(
            user_id=test_user.id,
            status="previewed",
            source="spreadsheet",
            filename="edges.csv",
            total_rows=4,
        )
        db.add(job)
        db.flush()
        db.add_all([
            InventoryImportRow(
                job_id=job.id, row_number=2, action="update", inventory_item_id=active.id,
                raw_data={"name": "Updated"}, mapped_data={"name": "Updated", "quantity": 5, "_import_id": "ignored"},
            ),
            InventoryImportRow(
                job_id=job.id, row_number=3, action="update", inventory_item_id=deleted.id,
                raw_data={"name": "Gone"}, mapped_data={"name": "Gone", "quantity": 2},
            ),
            InventoryImportRow(
                job_id=job.id, row_number=6, action="update", inventory_item_id=unchanged.id,
                raw_data={"name": "Stable"}, mapped_data={"name": "Stable", "quantity": 4},
            ),
            InventoryImportRow(
                job_id=job.id, row_number=4, action="error", raw_data={}, mapped_data=None,
                error_message="bad row",
            ),
            InventoryImportRow(
                job_id=job.id, row_number=5, action="skip", raw_data={"name": "Skip"}, mapped_data={"name": "Skip"},
            ),
        ])
        db.commit()

        resp = client.post(f"/api/v1/inventory/imports/{job.id}/commit", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["rows_updated"] == 2
        assert resp.json()["rows_skipped"] == 3
        db.refresh(active)
        assert active.name == "Updated" and active.quantity == 5
        ledger = db.query(InventoryStockLedger).filter_by(inventory_item_id=active.id).one()
        assert ledger.delta_quantity == 3 and ledger.quantity_after == 5


class TestCSVRoundTrip:
    """Regression tests for export → re-import column alignment.

    The canonical export writes snake_case column headers (buy_price,
    expected_sell_price, vendor_name, actual_sell_price).  The import must
    recognise those exact names so a round-trip works without remapping.
    """

    def _make_csv(self, rows: list[dict]) -> bytes:
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
        return buf.getvalue().encode()

    def _make_pro_headers(self, client, auth_headers, db, test_user):
        """Upgrade test user to Pro in-place and return same headers."""
        test_user.subscription_tier = "pro"
        db.add(test_user)
        db.commit()
        return auth_headers

    def test_snake_case_buy_price_is_mapped(self, client, auth_headers):
        """Export column 'buy_price' (snake_case) is recognised on re-import."""
        csv_bytes = self._make_csv([
            {"name": "Round Trip Shoe", "sku": "RT-001", "buy_price": "99.99", "quantity": "2"},
        ])
        resp = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("export.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["rows_errored"] == 0
        row = data["rows"][0]
        assert row["action"] == "create"
        # buy_price must appear in mapped_data, not be silently dropped
        assert "buy_price" in row["mapped_data"]
        assert abs(float(row["mapped_data"]["buy_price"]) - 99.99) < 0.01

    def test_snake_case_expected_sell_price_is_mapped(self, client, auth_headers):
        """Export column 'expected_sell_price' is recognised on re-import."""
        csv_bytes = self._make_csv([
            {"name": "Round Trip Shirt", "sku": "RT-002",
             "expected_sell_price": "149.00", "quantity": "1"},
        ])
        resp = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("export.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        )
        assert resp.status_code == 201
        row = resp.json()["rows"][0]
        assert "expected_sell_price" in row["mapped_data"]
        assert abs(float(row["mapped_data"]["expected_sell_price"]) - 149.00) < 0.01

    def test_snake_case_vendor_name_is_mapped(self, client, auth_headers):
        """Export column 'vendor_name' is recognised on re-import."""
        csv_bytes = self._make_csv([
            {"name": "Vendor Test Item", "sku": "RT-003",
             "vendor_name": "Kick Game Supply", "quantity": "1"},
        ])
        resp = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("export.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        )
        assert resp.status_code == 201
        row = resp.json()["rows"][0]
        assert row["mapped_data"]["vendor_name"] == "Kick Game Supply"

    def test_actual_sell_price_is_mapped(self, client, auth_headers):
        """Export column 'actual_sell_price' is recognised on re-import."""
        csv_bytes = self._make_csv([
            {"name": "Sold Item", "sku": "RT-004",
             "actual_sell_price": "210.00", "quantity": "1"},
        ])
        resp = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("export.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        )
        assert resp.status_code == 201
        row = resp.json()["rows"][0]
        assert "actual_sell_price" in row["mapped_data"]
        assert abs(float(row["mapped_data"]["actual_sell_price"]) - 210.00) < 0.01

    def test_full_export_columns_round_trip(self, client, auth_headers, db, test_user):
        """A CSV using all canonical export column names previews without errors."""
        pro_headers = self._make_pro_headers(client, auth_headers, db, test_user)

        # Create an item and export it.
        client.post("/api/v1/inventory", json={
            "name": "Export Me", "sku": "EXP-001",
            "buy_price": "80.00", "expected_sell_price": "140.00",
            "vendor_name": "Test Vendor", "quantity": 2,
        }, headers=pro_headers)

        export_resp = client.get("/api/v1/export/inventory", headers=pro_headers)
        assert export_resp.status_code == 200
        csv_content = export_resp.text

        # Re-import the exact CSV that was just exported.
        resp = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("vendora_inventory.csv",
                            csv_content.encode("utf-8"), "text/csv")},
            headers=pro_headers,
        )
        assert resp.status_code == 201
        data = resp.json()
        # Must detect as an update (matched by id) — no duplicate creates.
        assert data["rows_to_create"] == 0
        assert data["rows_to_update"] == 1
        assert data["rows_errored"] == 0
        row = data["rows"][0]
        # buy_price, expected_sell_price, vendor_name must all be in mapped_data.
        assert "buy_price" in row["mapped_data"]
        assert "expected_sell_price" in row["mapped_data"]
        assert "vendor_name" in row["mapped_data"]

    def test_photo_url_columns_round_trip_on_create(self, client, auth_headers):
        """Raw photo url columns are importable and persist on create."""
        csv_bytes = self._make_csv([
            {
                "name": "Photo Item",
                "sku": "PHOTO-001",
                "quantity": "1",
                "photo_front_url": "https://cdn.example/front.jpg",
                "photo_back_url": "https://cdn.example/back.jpg",
            },
        ])
        preview = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("photo.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        )
        assert preview.status_code == 201
        row = preview.json()["rows"][0]
        assert row["mapped_data"]["photo_front_url"] == "https://cdn.example/front.jpg"
        assert row["mapped_data"]["photo_back_url"] == "https://cdn.example/back.jpg"

        commit = client.post(
            f"/api/v1/inventory/imports/{preview.json()['job_id']}/commit",
            headers=auth_headers,
        )
        assert commit.status_code == 200

        inventory = client.get("/api/v1/inventory?q=PHOTO-001", headers=auth_headers).json()
        assert inventory["total"] == 1
        assert inventory["items"][0]["photo_front_url"] == "https://cdn.example/front.jpg"
        assert inventory["items"][0]["photo_back_url"] == "https://cdn.example/back.jpg"

    def test_helper_image_formula_columns_are_ignored_on_preview(self, client, auth_headers):
        """Spreadsheet helper formula columns remain export-only."""
        csv_bytes = self._make_csv([
            {
                "name": "Formula Item",
                "sku": "FORM-001",
                "quantity": "1",
                "photo_front_url": "https://cdn.example/front.jpg",
                "front_image_formula": '=IMAGE("https://cdn.example/front.jpg")',
            },
        ])
        preview = client.post(
            "/api/v1/inventory/imports/preview",
            files={"file": ("formula.csv", csv_bytes, "text/csv")},
            headers=auth_headers,
        )
        assert preview.status_code == 201
        row = preview.json()["rows"][0]
        assert "photo_front_url" in row["mapped_data"]
        assert "front_image_formula" not in row["mapped_data"]


class TestInventoryActivityAPI:
    def test_activity_endpoint_returns_stock_ledger_entries(self, client, auth_headers):
        item = client.post("/api/v1/inventory", json={
            "name": "Activity Item",
            "quantity": 3,
        }, headers=auth_headers).json()

        sale = client.post("/api/v1/transactions", json={
            "item_id": item["id"],
            "method": "cash",
            "gross_amount": "90.00",
            "quantity": 1,
        }, headers=auth_headers)
        assert sale.status_code == 201

        resp = client.get(f"/api/v1/inventory/{item['id']}/activity", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["inventory_item_id"] == item["id"]
        assert data[0]["event_type"] == "sale"
        assert data[0]["delta_quantity"] == -1
        assert data[0]["quantity_after"] == 2
