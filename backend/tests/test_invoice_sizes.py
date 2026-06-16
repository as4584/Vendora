"""Invoice size selection regressions."""


def test_create_invoice_with_selected_size(client, auth_headers):
    item = client.post("/api/v1/inventory", json={
        "name": "Variant Hoodie",
        "quantity": 3,
        "custom_attributes": {
            "variants": [
                {"size": "M", "quantity": 1},
                {"size": "L", "quantity": 2},
            ]
        },
    }, headers=auth_headers).json()

    resp = client.post("/api/v1/invoices", json={
        "customer_name": "Sized Buyer",
        "items": [{
            "description": "Variant Hoodie - Size L",
            "quantity": 1,
            "unit_price": "80.00",
            "inventory_item_id": item["id"],
            "size_label": "L",
        }],
    }, headers=auth_headers)

    assert resp.status_code == 201
    assert resp.json()["items"][0]["size_label"] == "L"


def test_paid_invoice_deducts_selected_size_variant(client, auth_headers):
    item = client.post("/api/v1/inventory", json={
        "name": "Variant Hoodie",
        "quantity": 3,
        "custom_attributes": {
            "variants": [
                {"size": "M", "quantity": 1},
                {"size": "L", "quantity": 2},
            ]
        },
    }, headers=auth_headers).json()

    resp = client.post("/api/v1/invoices", json={
        "customer_name": "Variant Buyer",
        "items": [{
            "description": "Variant Hoodie - Size L",
            "quantity": 1,
            "unit_price": "80.00",
            "inventory_item_id": item["id"],
            "size_label": "L",
        }],
    }, headers=auth_headers)
    inv_id = resp.json()["id"]

    client.patch(f"/api/v1/invoices/{inv_id}/status", json={"status": "sent"}, headers=auth_headers)
    client.patch(f"/api/v1/invoices/{inv_id}/status", json={"status": "paid"}, headers=auth_headers)

    updated = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
    assert updated["quantity"] == 2
    assert updated["custom_attributes"]["variants"] == [
        {"size": "M", "quantity": 1},
        {"size": "L", "quantity": 1},
    ]
