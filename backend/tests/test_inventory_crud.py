"""Inventory CRUD tests — /api/v1/inventory/*

Coverage: create, list (paginated), get, update, soft-delete, ownership enforcement.
Soft-delete 404 rule: deleted items must return 404.
"""
import pytest


SAMPLE_ITEM = {
    "name": "Jordan 1 Retro High OG",
    "category": "sneakers",
    "sku": "SKU-001",
    "size": "10",
    "color": "red/black",
    "condition": "new",
    "buy_price": "120.00",
    "expected_sell_price": "250.00",
}


class TestCreateItem:
    def test_create_item_success(self, client, auth_headers):
        resp = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers)
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == SAMPLE_ITEM["name"]
        assert data["status"] == "in_stock"
        assert data["category"] == "sneakers"

    def test_create_item_minimal(self, client, auth_headers):
        resp = client.post("/api/v1/inventory", json={"name": "Basic Item"}, headers=auth_headers)
        assert resp.status_code == 201
        assert resp.json()["status"] == "in_stock"

    def test_create_item_unauthenticated(self, client):
        resp = client.post("/api/v1/inventory", json=SAMPLE_ITEM)
        assert resp.status_code == 403


class TestListItems:
    def test_list_empty(self, client, auth_headers):
        resp = client.get("/api/v1/inventory", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["items"] == []
        assert data["total"] == 0

    def test_list_with_items(self, client, auth_headers):
        for i in range(3):
            client.post("/api/v1/inventory", json={"name": f"Item {i}"}, headers=auth_headers)
        resp = client.get("/api/v1/inventory", headers=auth_headers)
        data = resp.json()
        assert data["total"] == 3
        assert len(data["items"]) == 3

    def test_pagination(self, client, auth_headers):
        for i in range(5):
            client.post("/api/v1/inventory", json={"name": f"Item {i}"}, headers=auth_headers)

        resp = client.get("/api/v1/inventory?page=1&per_page=2", headers=auth_headers)
        data = resp.json()
        assert len(data["items"]) == 2
        assert data["total"] == 5
        assert data["pages"] == 3


class TestGetItem:
    def test_get_item(self, client, auth_headers):
        create_resp = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers)
        item_id = create_resp.json()["id"]
        resp = client.get(f"/api/v1/inventory/{item_id}", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["id"] == item_id

    def test_get_nonexistent_item(self, client, auth_headers):
        resp = client.get("/api/v1/inventory/00000000-0000-0000-0000-000000000000", headers=auth_headers)
        assert resp.status_code == 404


class TestUpdateItem:
    def test_update_item(self, client, auth_headers):
        create_resp = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers)
        item_id = create_resp.json()["id"]
        resp = client.put(f"/api/v1/inventory/{item_id}", json={"name": "Updated Name"}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["name"] == "Updated Name"
        # Other fields unchanged
        assert resp.json()["category"] == "sneakers"


class TestDeleteItem:
    def test_soft_delete(self, client, auth_headers):
        create_resp = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers)
        item_id = create_resp.json()["id"]

        # Delete
        resp = client.delete(f"/api/v1/inventory/{item_id}", headers=auth_headers)
        assert resp.status_code == 204

        # Verify 404 on GET (soft-delete 404 rule)
        resp = client.get(f"/api/v1/inventory/{item_id}", headers=auth_headers)
        assert resp.status_code == 404

        # Verify excluded from list
        resp = client.get("/api/v1/inventory", headers=auth_headers)
        assert resp.json()["total"] == 0


class TestOwnershipEnforcement:
    def test_user_cannot_see_other_users_items(self, client, auth_headers, second_auth_headers):
        # User A creates item
        create_resp = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers)
        item_id = create_resp.json()["id"]

        # User B tries to access — must get 404
        resp = client.get(f"/api/v1/inventory/{item_id}", headers=second_auth_headers)
        assert resp.status_code == 404

    def test_user_cannot_update_other_users_items(self, client, auth_headers, second_auth_headers):
        create_resp = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers)
        item_id = create_resp.json()["id"]
        resp = client.put(f"/api/v1/inventory/{item_id}", json={"name": "Hacked"}, headers=second_auth_headers)
        assert resp.status_code == 404

    def test_user_cannot_delete_other_users_items(self, client, auth_headers, second_auth_headers):
        create_resp = client.post("/api/v1/inventory", json=SAMPLE_ITEM, headers=auth_headers)
        item_id = create_resp.json()["id"]
        resp = client.delete(f"/api/v1/inventory/{item_id}", headers=second_auth_headers)
        assert resp.status_code == 404

    def test_lists_only_own_items(self, client, auth_headers, second_auth_headers):
        client.post("/api/v1/inventory", json={"name": "User A Item"}, headers=auth_headers)
        client.post("/api/v1/inventory", json={"name": "User B Item"}, headers=second_auth_headers)

        resp_a = client.get("/api/v1/inventory", headers=auth_headers)
        resp_b = client.get("/api/v1/inventory", headers=second_auth_headers)

        assert resp_a.json()["total"] == 1
        assert resp_a.json()["items"][0]["name"] == "User A Item"
        assert resp_b.json()["total"] == 1
        assert resp_b.json()["items"][0]["name"] == "User B Item"
