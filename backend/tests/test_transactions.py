"""Transaction endpoint tests — /api/v1/transactions

Coverage: Quick Sale, manual payment log, listing, refund flow, double-refund guard.
"""
import pytest
from fastapi import HTTPException


SAMPLE_ITEM = {
    "name": "Jordan 1 Retro High OG",
    "category": "sneakers",
    "buy_price": "120.00",
    "expected_sell_price": "250.00",
}


class TestCreateTransaction:
    def test_missing_item_returns_404(self, client, auth_headers):
        resp = client.post("/api/v1/transactions", json={
            "item_id": "00000000-0000-0000-0000-000000000000",
            "method": "cash",
            "gross_amount": "10.00",
        }, headers=auth_headers)
        assert resp.status_code == 404

    def test_stock_service_failure_uses_status_fallback(self, client, auth_headers, monkeypatch):
        from app.routers import transactions

        item = client.post("/api/v1/inventory", json={"name": "Fallback Item", "quantity": 2}, headers=auth_headers).json()

        def fail(*args, **kwargs):
            raise HTTPException(status_code=409, detail="ledger unavailable")

        monkeypatch.setattr(transactions, "deduct_stock", fail)
        resp = client.post("/api/v1/transactions", json={
            "item_id": item["id"], "method": "cash", "gross_amount": "10.00",
        }, headers=auth_headers)
        assert resp.status_code == 201
        updated = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
        assert updated["status"] == "sold"

    def test_quick_sale_with_item(self, client, auth_headers):
        """Quick Sale: create item → log transaction → item auto-transitions to sold."""
        # Create item
        item_resp = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers)
        item_id = item_resp.json()["id"]
        assert item_resp.json()["status"] == "in_stock"

        # Quick Sale
        txn_resp = client.post("/api/v1/transactions", json={
            "item_id": item_id,
            "method": "cash",
            "gross_amount": "250.00",
            "fee_amount": "0.00",
        }, headers=auth_headers)
        assert txn_resp.status_code == 201
        txn = txn_resp.json()
        assert txn["gross_amount"] == "250.00"
        assert txn["net_amount"] == "250.00"
        assert txn["is_refund"] is False
        assert txn["item_id"] == item_id

        # Verify item moved to sold
        item = client.get(f"/api/v1/inventory/{item_id}", headers=auth_headers).json()
        assert item["status"] == "sold"
        assert item["actual_sell_price"] == "250.00"

    def test_manual_payment_log_no_item(self, client, auth_headers):
        """Log a payment without linking to inventory item."""
        txn_resp = client.post("/api/v1/transactions", json={
            "method": "venmo",
            "gross_amount": "75.00",
            "fee_amount": "1.50",
            "notes": "Side hustle sale",
        }, headers=auth_headers)
        assert txn_resp.status_code == 201
        txn = txn_resp.json()
        assert txn["net_amount"] == "73.50"  # 75 - 1.50
        assert txn["item_id"] is None
        assert txn["notes"] == "Side hustle sale"

    def test_transaction_with_fee(self, client, auth_headers):
        """Fee deducted from net amount."""
        txn_resp = client.post("/api/v1/transactions", json={
            "method": "paypal",
            "gross_amount": "100.00",
            "fee_amount": "3.49",
        }, headers=auth_headers)
        assert txn_resp.status_code == 201
        assert txn_resp.json()["net_amount"] == "96.51"

    def test_fee_cannot_exceed_gross(self, client, auth_headers):
        """Fee > gross should be rejected."""
        resp = client.post("/api/v1/transactions", json={
            "method": "cash",
            "gross_amount": "10.00",
            "fee_amount": "20.00",
        }, headers=auth_headers)
        assert resp.status_code == 422

    def test_invalid_payment_method(self, client, auth_headers):
        resp = client.post("/api/v1/transactions", json={
            "method": "bitcoin",
            "gross_amount": "50.00",
        }, headers=auth_headers)
        assert resp.status_code == 422

    def test_unauthenticated(self, client):
        resp = client.post("/api/v1/transactions", json={
            "method": "cash",
            "gross_amount": "50.00",
        })
        assert resp.status_code == 401


class TestListTransactions:
    def test_list_empty(self, client, auth_headers):
        resp = client.get("/api/v1/transactions", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["total"] == 0

    def test_list_with_transactions(self, client, auth_headers):
        for i in range(3):
            client.post("/api/v1/transactions", json={
                "method": "cash",
                "gross_amount": f"{(i + 1) * 50}.00",
            }, headers=auth_headers)

        resp = client.get("/api/v1/transactions", headers=auth_headers)
        data = resp.json()
        assert data["total"] == 3

    def test_ownership_isolation(self, client, auth_headers, second_auth_headers):
        client.post("/api/v1/transactions", json={
            "method": "cash", "gross_amount": "100.00",
        }, headers=auth_headers)
        client.post("/api/v1/transactions", json={
            "method": "cash", "gross_amount": "200.00",
        }, headers=second_auth_headers)

        a_resp = client.get("/api/v1/transactions", headers=auth_headers)
        b_resp = client.get("/api/v1/transactions", headers=second_auth_headers)
        assert a_resp.json()["total"] == 1
        assert b_resp.json()["total"] == 1

    def test_filter_by_item_id(self, client, auth_headers):
        item_a = client.post("/api/v1/inventory", json={
            "name": "Filtered Item A",
            "quantity": 2,
        }, headers=auth_headers).json()
        item_b = client.post("/api/v1/inventory", json={
            "name": "Filtered Item B",
            "quantity": 2,
        }, headers=auth_headers).json()

        client.post("/api/v1/transactions", json={
            "item_id": item_a["id"],
            "method": "cash",
            "gross_amount": "50.00",
        }, headers=auth_headers)
        client.post("/api/v1/transactions", json={
            "item_id": item_b["id"],
            "method": "cash",
            "gross_amount": "75.00",
        }, headers=auth_headers)

        resp = client.get(f"/api/v1/transactions?item_id={item_a['id']}", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert data["items"][0]["item_id"] == item_a["id"]


class TestGetTransaction:
    def test_get_existing_and_missing(self, client, auth_headers):
        txn = client.post("/api/v1/transactions", json={
            "method": "cash", "gross_amount": "12.00",
        }, headers=auth_headers).json()
        assert client.get(f"/api/v1/transactions/{txn['id']}", headers=auth_headers).status_code == 200
        missing = client.get("/api/v1/transactions/00000000-0000-0000-0000-000000000000", headers=auth_headers)
        assert missing.status_code == 404


class TestRefund:
    def test_missing_transaction_returns_404(self, client, auth_headers):
        resp = client.post(
            "/api/v1/transactions/00000000-0000-0000-0000-000000000000/refund",
            json={}, headers=auth_headers,
        )
        assert resp.status_code == 404

    def test_restore_service_failure_uses_status_fallback(self, client, auth_headers, monkeypatch):
        from app.routers import transactions

        item = client.post("/api/v1/inventory", json={"name": "Refund Fallback", "quantity": 1}, headers=auth_headers).json()
        txn = client.post("/api/v1/transactions", json={
            "item_id": item["id"], "method": "cash", "gross_amount": "15.00",
        }, headers=auth_headers).json()

        def fail(*args, **kwargs):
            raise HTTPException(status_code=409, detail="ledger unavailable")

        monkeypatch.setattr(transactions, "restore_stock", fail)
        resp = client.post(f"/api/v1/transactions/{txn['id']}/refund", json={}, headers=auth_headers)
        assert resp.status_code == 201
        updated = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
        assert updated["status"] == "in_stock"
        assert updated["actual_sell_price"] is None

    def test_refund_skips_deleted_item_and_non_sold_fallback(self, client, auth_headers, db, monkeypatch):
        from app.routers import transactions
        from app.models.inventory import InventoryItem
        from datetime import datetime, timezone
        import uuid

        item = client.post("/api/v1/inventory", json={"name": "Partial", "quantity": 2}, headers=auth_headers).json()
        txn = client.post("/api/v1/transactions", json={
            "item_id": item["id"], "method": "cash", "gross_amount": "10.00", "quantity": 1,
        }, headers=auth_headers).json()
        monkeypatch.setattr(
            transactions,
            "restore_stock",
            lambda *args, **kwargs: (_ for _ in ()).throw(HTTPException(status_code=409)),
        )
        assert client.post(f"/api/v1/transactions/{txn['id']}/refund", json={}, headers=auth_headers).status_code == 201

        deleted = client.post("/api/v1/inventory", json={"name": "Deleted after sale", "quantity": 1}, headers=auth_headers).json()
        deleted_txn = client.post("/api/v1/transactions", json={
            "item_id": deleted["id"], "method": "cash", "gross_amount": "11.00",
        }, headers=auth_headers).json()
        model = db.get(InventoryItem, uuid.UUID(deleted["id"]))
        model.deleted_at = datetime.now(timezone.utc)
        db.commit()
        assert client.post(f"/api/v1/transactions/{deleted_txn['id']}/refund", json={}, headers=auth_headers).status_code == 201
    def test_refund_creates_negative_entry(self, client, auth_headers):
        """Per STATE_MACHINES.md: Refund creates negative transaction entry."""
        # Create sale
        txn = client.post("/api/v1/transactions", json={
            "method": "cash",
            "gross_amount": "100.00",
            "fee_amount": "5.00",
        }, headers=auth_headers).json()

        # Refund
        refund_resp = client.post(
            f"/api/v1/transactions/{txn['id']}/refund",
            json={"reason": "Customer returned item"},
            headers=auth_headers,
        )
        assert refund_resp.status_code == 201
        refund = refund_resp.json()
        assert refund["is_refund"] is True
        assert refund["net_amount"] == "-95.00"  # -(100 - 5)
        assert refund["original_transaction_id"] == txn["id"]

    def test_refund_reverts_item_to_in_stock(self, client, auth_headers):
        """Refund reverts item back to in_stock if currently sold."""
        # Create item + Quick Sale
        item = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers).json()
        txn = client.post("/api/v1/transactions", json={
            "item_id": item["id"],
            "method": "cash",
            "gross_amount": "250.00",
        }, headers=auth_headers).json()

        # Verify sold
        assert client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()["status"] == "sold"

        # Refund
        client.post(f"/api/v1/transactions/{txn['id']}/refund", json={}, headers=auth_headers)

        # Verify reverted
        updated = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
        assert updated["status"] == "in_stock"
        assert updated["actual_sell_price"] is None

    def test_double_refund_blocked(self, client, auth_headers):
        """Cannot refund the same transaction twice."""
        txn = client.post("/api/v1/transactions", json={
            "method": "cash", "gross_amount": "50.00",
        }, headers=auth_headers).json()

        # First refund OK
        resp1 = client.post(f"/api/v1/transactions/{txn['id']}/refund", json={}, headers=auth_headers)
        assert resp1.status_code == 201

        # Second refund blocked
        resp2 = client.post(f"/api/v1/transactions/{txn['id']}/refund", json={}, headers=auth_headers)
        assert resp2.status_code == 400
        assert resp2.json()["detail"]["error"] == "already_refunded"

    def test_cannot_refund_refund(self, client, auth_headers):
        """Cannot refund a refund transaction."""
        txn = client.post("/api/v1/transactions", json={
            "method": "cash", "gross_amount": "50.00",
        }, headers=auth_headers).json()

        refund = client.post(f"/api/v1/transactions/{txn['id']}/refund", json={}, headers=auth_headers).json()

        resp = client.post(f"/api/v1/transactions/{refund['id']}/refund", json={}, headers=auth_headers)
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"] == "cannot_refund_refund"


class TestQuantityAndStockLedger:
    def test_quantity_field_in_response(self, client, auth_headers):
        """quantity field is present in transaction response (defaults to 1)."""
        resp = client.post("/api/v1/transactions", json={
            "method": "cash",
            "gross_amount": "100.00",
        }, headers=auth_headers)
        assert resp.status_code == 201
        assert resp.json()["quantity"] == 1

    def test_quantity_sent_is_stored(self, client, auth_headers):
        """quantity value from request is persisted."""
        item = client.post("/api/v1/inventory", json={
            "name": "Multi-pack Socks",
            "quantity": 10,
        }, headers=auth_headers).json()

        resp = client.post("/api/v1/transactions", json={
            "item_id": item["id"],
            "method": "cash",
            "gross_amount": "30.00",
            "quantity": 3,
        }, headers=auth_headers)
        assert resp.status_code == 201
        assert resp.json()["quantity"] == 3

    def test_partial_deduction_keeps_item_in_stock(self, client, auth_headers):
        """Buying some but not all units keeps the item in_stock with reduced quantity."""
        item = client.post("/api/v1/inventory", json={
            "name": "Bulk T-Shirt",
            "quantity": 5,
        }, headers=auth_headers).json()
        assert item["quantity"] == 5

        client.post("/api/v1/transactions", json={
            "item_id": item["id"],
            "method": "cash",
            "gross_amount": "50.00",
            "quantity": 2,
        }, headers=auth_headers)

        updated = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
        assert updated["quantity"] == 3
        assert updated["status"] == "in_stock"

    def test_full_deduction_transitions_to_sold(self, client, auth_headers):
        """Buying all units transitions status to sold."""
        item = client.post("/api/v1/inventory", json={
            "name": "Last Pair Jordans",
            "quantity": 1,
        }, headers=auth_headers).json()

        client.post("/api/v1/transactions", json={
            "item_id": item["id"],
            "method": "cash",
            "gross_amount": "250.00",
            "quantity": 1,
        }, headers=auth_headers)

        updated = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
        assert updated["status"] == "sold"
        assert updated["quantity"] == 0

    def test_insufficient_stock_returns_409(self, client, auth_headers):
        """Requesting more units than available returns HTTP 409."""
        item = client.post("/api/v1/inventory", json={
            "name": "Low Stock Item",
            "quantity": 1,
        }, headers=auth_headers).json()

        resp = client.post("/api/v1/transactions", json={
            "item_id": item["id"],
            "method": "cash",
            "gross_amount": "100.00",
            "quantity": 5,
        }, headers=auth_headers)
        assert resp.status_code == 409
        assert resp.json()["detail"]["error"] == "insufficient_stock"

    def test_refund_restores_quantity(self, client, auth_headers):
        """Refund increments item quantity and reverts status to in_stock."""
        item = client.post("/api/v1/inventory", json={
            "name": "Returnable Item",
            "quantity": 2,
        }, headers=auth_headers).json()

        txn = client.post("/api/v1/transactions", json={
            "item_id": item["id"],
            "method": "cash",
            "gross_amount": "80.00",
            "quantity": 2,
        }, headers=auth_headers).json()

        # Item should be sold now
        assert client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()["status"] == "sold"

        # Refund
        client.post(f"/api/v1/transactions/{txn['id']}/refund", json={}, headers=auth_headers)

        updated = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
        assert updated["status"] == "in_stock"
        assert updated["quantity"] == 2
        assert updated["actual_sell_price"] is None

    def test_invoice_id_in_refund_response(self, client, auth_headers):
        """Refund transaction carries invoice_id from original transaction."""
        txn = client.post("/api/v1/transactions", json={
            "method": "cash",
            "gross_amount": "75.00",
        }, headers=auth_headers).json()
        # original has no invoice_id (manual transaction)
        assert txn["invoice_id"] is None

        refund = client.post(
            f"/api/v1/transactions/{txn['id']}/refund", json={}, headers=auth_headers
        ).json()
        # Refund carries the same (null) invoice_id
        assert refund["invoice_id"] is None
