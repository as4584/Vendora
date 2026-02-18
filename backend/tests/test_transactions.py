"""Transaction endpoint tests — /api/v1/transactions

Coverage: Quick Sale, manual payment log, listing, refund flow, double-refund guard.
"""
import pytest


SAMPLE_ITEM = {
    "name": "Jordan 1 Retro High OG",
    "category": "sneakers",
    "buy_price": "120.00",
    "expected_sell_price": "250.00",
}


class TestCreateTransaction:
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
        assert resp.status_code == 403


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


class TestRefund:
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
