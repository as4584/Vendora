"""Golden Frame scenarios — end-to-end business flow tests.

Per ROADMAP Sprint 2 success criteria:
    1. Add item → sell → profit calc
    2. Refund → profit adjust
    3. Log sale in <5 seconds (performance)
"""
import time

import pytest


class TestGoldenFrameAddSellProfit:
    def test_full_sale_lifecycle(self, client, auth_headers):
        """Golden Frame: Add item → Quick Sale → Dashboard shows correct profit.

        Scenario:
            - Buy a sneaker for $120
            - Sell it for $250 via cash
            - Expected profit: 250 - 120 = $130
        """
        # 1. Add item
        item = client.post("/api/v1/inventory", json={
            "name": "Jordan 1 Chicago",
            "category": "sneakers",
            "buy_price": "120.00",
            "expected_sell_price": "250.00",
        }, headers=auth_headers).json()
        assert item["status"] == "in_stock"

        # 2. Quick Sale
        txn = client.post("/api/v1/transactions", json={
            "item_id": item["id"],
            "method": "cash",
            "gross_amount": "250.00",
        }, headers=auth_headers).json()
        assert txn["status"] == "completed"
        assert txn["net_amount"] == "250.00"

        # 3. Verify item is sold
        sold_item = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
        assert sold_item["status"] == "sold"
        assert sold_item["actual_sell_price"] == "250.00"

        # 4. Dashboard shows correct numbers
        dashboard = client.get("/api/v1/dashboard", headers=auth_headers).json()
        assert dashboard["revenue_today"] == "250.00"
        assert dashboard["total_transactions"] == 1
        assert dashboard["items_sold"] == 1


class TestGoldenFrameRefundAdjust:
    def test_refund_adjusts_everything(self, client, auth_headers):
        """Golden Frame: Sell → Refund → profit adjusts, item reverts.

        Scenario:
            - Buy for $120, sell for $250
            - Customer returns, refund issued
            - Item goes back to in_stock
            - Revenue adjusted downward
        """
        # 1. Add + sell
        item = client.post("/api/v1/inventory", json={
            "name": "Nike Dunk Low",
            "buy_price": "100.00",
            "expected_sell_price": "180.00",
        }, headers=auth_headers).json()

        txn = client.post("/api/v1/transactions", json={
            "item_id": item["id"],
            "method": "cashapp",
            "gross_amount": "180.00",
            "fee_amount": "5.00",
        }, headers=auth_headers).json()

        # 2. Verify sold
        dashboard_pre = client.get("/api/v1/dashboard", headers=auth_headers).json()
        assert dashboard_pre["revenue_today"] == "180.00"

        # 3. Refund
        refund = client.post(
            f"/api/v1/transactions/{txn['id']}/refund",
            json={"reason": "Customer changed mind"},
            headers=auth_headers,
        ).json()
        assert refund["is_refund"] is True
        assert refund["net_amount"] == "-175.00"  # -(180 - 5)

        # 4. Item reverted
        updated_item = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
        assert updated_item["status"] == "in_stock"
        assert updated_item["actual_sell_price"] is None

        # 5. Dashboard adjusted
        dashboard_post = client.get("/api/v1/dashboard", headers=auth_headers).json()
        # Revenue: 180 gross - 180 refund = 0
        assert dashboard_post["revenue_today"] == "0.00"
        assert dashboard_post["total_refunds"] == 1


class TestGoldenFramePerformance:
    def test_quick_sale_under_5_seconds(self, client, auth_headers):
        """Golden Frame: Log sale in <5 seconds (Sprint 2 success criteria)."""
        # Create item
        item = client.post("/api/v1/inventory", json={
            "name": "Performance Test Item",
            "buy_price": "50.00",
        }, headers=auth_headers).json()

        # Time the Quick Sale
        start = time.time()
        resp = client.post("/api/v1/transactions", json={
            "item_id": item["id"],
            "method": "cash",
            "gross_amount": "100.00",
        }, headers=auth_headers)
        elapsed = time.time() - start

        assert resp.status_code == 201
        assert elapsed < 5.0, f"Quick Sale took {elapsed:.2f}s — must be under 5s"


class TestGoldenFrameMultiItemBatch:
    def test_multiple_sales_profit_accuracy(self, client, auth_headers):
        """Multiple items sold — dashboard aggregation must be accurate.

        3 items: buy $100/$80/$60, sell $200/$150/$120
        Total revenue: 470
        Total cost: 240
        """
        items = []
        prices = [
            ("100.00", "200.00"),
            ("80.00", "150.00"),
            ("60.00", "120.00"),
        ]

        for buy, sell in prices:
            item = client.post("/api/v1/inventory", json={
                "name": f"Batch Item {buy}",
                "buy_price": buy,
                "expected_sell_price": sell,
            }, headers=auth_headers).json()
            items.append(item)

        # Sell all
        for item, (buy, sell) in zip(items, prices):
            client.post("/api/v1/transactions", json={
                "item_id": item["id"],
                "method": "cash",
                "gross_amount": sell,
            }, headers=auth_headers)

        dashboard = client.get("/api/v1/dashboard", headers=auth_headers).json()
        assert dashboard["revenue_today"] == "470.00"
        assert dashboard["total_transactions"] == 3
        assert dashboard["items_sold"] == 3
