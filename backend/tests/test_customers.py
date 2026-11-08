"""Customers: derived from invoices/checkouts, list + detail stats, pickers."""
from decimal import Decimal

from app.models.inventory import InventoryItem


def _item(db, user, name="Dunk Low", qty=3, price="150.00"):
    item = InventoryItem(
        user_id=user.id, name=name, category="Sneakers", buy_price=Decimal("90.00"),
        expected_sell_price=Decimal(price), quantity=qty, condition="New",
    )
    db.add(item)
    db.commit()
    return item


def _invoice(client, headers, **extra):
    body = {
        "customer_name": "Marcus Reed",
        "customer_email": "Marcus@Example.com",
        "items": [{"description": "Samba", "quantity": 1, "unit_price": "130.00"}],
    }
    body.update(extra)
    resp = client.post("/api/v1/invoices", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestDerivedFromInvoices:
    def test_invoice_creates_customer(self, client, auth_headers):
        inv = _invoice(client, auth_headers, customer_phone="(201) 555-0100")
        assert inv["customer_id"]
        assert inv["customer_phone"] == "(201) 555-0100"
        listing = client.get("/api/v1/customers", headers=auth_headers).json()
        assert listing["total"] == 1
        c = listing["items"][0]
        assert c["name"] == "Marcus Reed"
        assert c["email"] == "marcus@example.com"
        assert c["phone"] == "2015550100"
        assert c["order_count"] == 1
        assert c["total_spent"] == "0.00"  # nothing paid yet

    def test_same_email_reuses_customer(self, client, auth_headers):
        a = _invoice(client, auth_headers)
        b = _invoice(client, auth_headers, customer_name="Marcus R.", customer_email="marcus@example.com ")
        assert a["customer_id"] == b["customer_id"]
        assert client.get("/api/v1/customers", headers=auth_headers).json()["total"] == 1

    def test_same_name_without_contact_reuses(self, client, auth_headers):
        a = _invoice(client, auth_headers, customer_name="Walk-in Jay", customer_email=None)
        b = _invoice(client, auth_headers, customer_name="walk-in jay", customer_email=None)
        assert a["customer_id"] == b["customer_id"]

    def test_paid_amount_counts_and_cancelled_is_skipped(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        pay = client.post(f"/api/v1/invoices/{inv['id']}/payments",
                          json={"amount": "50.00", "method": "cash"}, headers=auth_headers)
        assert pay.status_code == 201, pay.text
        void = _invoice(client, auth_headers)
        r = client.patch(f"/api/v1/invoices/{void['id']}/status", json={"status": "cancelled"}, headers=auth_headers)
        assert r.status_code == 200, r.text
        c = client.get(f"/api/v1/customers/{inv['customer_id']}", headers=auth_headers).json()
        assert c["total_spent"] == "50.00"
        assert c["order_count"] == 1
        assert len(c["invoices"]) == 2  # history still shows the voided one
        assert {i["status"] for i in c["invoices"]} == {"partially_paid", "cancelled"}

    def test_pick_existing_customer_on_invoice(self, client, auth_headers):
        c = client.post("/api/v1/customers", json={"name": "Dana Cards", "phone": "+1 732 555 0199"},
                        headers=auth_headers).json()
        inv = _invoice(client, auth_headers, customer_name="Dana Cards", customer_email=None, customer_id=c["id"])
        assert inv["customer_id"] == c["id"]

    def test_cannot_pick_another_sellers_customer(self, client, auth_headers, second_auth_headers):
        other = client.post("/api/v1/customers", json={"name": "Not Yours"}, headers=second_auth_headers).json()
        resp = client.post("/api/v1/invoices", json={
            "customer_name": "x", "customer_id": other["id"],
            "items": [{"description": "x", "quantity": 1, "unit_price": "1.00"}],
        }, headers=auth_headers)
        assert resp.status_code == 404


class TestCheckout:
    def test_checkout_tags_customer_and_counts_total(self, client, auth_headers, db, test_user):
        item = _item(db, test_user)
        c = client.post("/api/v1/customers", json={"name": "Show Buyer"}, headers=auth_headers).json()
        order = client.post("/api/v1/transactions/order", json={
            "method": "cash", "tax_rate": "10", "customer_id": c["id"],
            "lines": [{"item_id": str(item.id), "quantity": 2, "unit_price": "100.00"}],
        }, headers=auth_headers)
        assert order.status_code == 201, order.text
        assert order.json()["customer_id"] == c["id"]
        detail = client.get(f"/api/v1/customers/{c['id']}", headers=auth_headers).json()
        assert detail["total_spent"] == "220.00"  # 200 + 10% tax
        assert detail["order_count"] == 1
        assert detail["orders"][0]["item_count"] == 2
        assert detail["last_purchase_at"]

    def test_refund_removes_from_total(self, client, auth_headers, db, test_user):
        item = _item(db, test_user)
        c = client.post("/api/v1/customers", json={"name": "Refunder"}, headers=auth_headers).json()
        order = client.post("/api/v1/transactions/order", json={
            "method": "card", "customer_id": c["id"],
            "lines": [{"item_id": str(item.id), "quantity": 1, "unit_price": "80.00"}],
        }, headers=auth_headers).json()
        txn_id = order["transactions"][0]["id"]
        r = client.post(f"/api/v1/transactions/{txn_id}/refund", json={"reason": "size"}, headers=auth_headers)
        assert r.status_code == 201
        assert r.json()["customer_id"] == c["id"]
        detail = client.get(f"/api/v1/customers/{c['id']}", headers=auth_headers).json()
        assert detail["total_spent"] == "0.00"
        assert detail["orders"][0]["refunded"] is True

    def test_checkout_rejects_foreign_customer(self, client, auth_headers, second_auth_headers, db, test_user):
        item = _item(db, test_user)
        other = client.post("/api/v1/customers", json={"name": "Theirs"}, headers=second_auth_headers).json()
        resp = client.post("/api/v1/transactions/order", json={
            "method": "cash", "customer_id": other["id"],
            "lines": [{"item_id": str(item.id), "quantity": 1, "unit_price": "10.00"}],
        }, headers=auth_headers)
        assert resp.status_code == 404
        db.refresh(item)
        assert item.quantity == 3  # nothing written


class TestCrud:
    def test_create_search_update(self, client, auth_headers):
        r = client.post("/api/v1/customers", json={
            "name": "Kim Wholesale", "email": "KIM@shop.com", "phone": "201-555-0123",
            "address": "1 Main St", "tax_exempt": True,
        }, headers=auth_headers)
        assert r.status_code == 201, r.text
        cid = r.json()["id"]
        assert r.json()["tax_exempt"] is True
        # Same email again returns the same customer.
        again = client.post("/api/v1/customers", json={"name": "Kim", "email": "kim@shop.com"}, headers=auth_headers)
        assert again.json()["id"] == cid
        for q in ("kim", "shop.com", "5550123"):
            hits = client.get(f"/api/v1/customers?q={q}", headers=auth_headers).json()
            assert [h["id"] for h in hits["items"]] == [cid], q
        assert client.get("/api/v1/customers?q=nobody", headers=auth_headers).json()["total"] == 0
        u = client.patch(f"/api/v1/customers/{cid}", json={"phone": "", "tax_exempt": False, "notes": "Net 15"},
                         headers=auth_headers)
        assert u.status_code == 200
        assert u.json()["phone"] is None and u.json()["tax_exempt"] is False and u.json()["notes"] == "Net 15"

    def test_isolation(self, client, auth_headers, second_auth_headers):
        cid = client.post("/api/v1/customers", json={"name": "Mine"}, headers=auth_headers).json()["id"]
        assert client.get(f"/api/v1/customers/{cid}", headers=second_auth_headers).status_code == 404
        assert client.patch(f"/api/v1/customers/{cid}", json={"name": "x"}, headers=second_auth_headers).status_code == 404
        assert client.get("/api/v1/customers", headers=second_auth_headers).json()["total"] == 0

    def test_requires_auth(self, client):
        assert client.get("/api/v1/customers").status_code == 401

    def test_blank_name_rejected(self, client, auth_headers):
        assert client.post("/api/v1/customers", json={"name": ""}, headers=auth_headers).status_code == 422


class TestInvoiceVoidAndDisconnect:
    def test_draft_invoice_can_be_voided(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        r = client.patch(f"/api/v1/invoices/{inv['id']}/status", json={"status": "cancelled"}, headers=auth_headers)
        assert r.status_code == 200
        assert r.json()["status"] == "cancelled"

    def test_square_and_clover_disconnect(self, client, auth_headers, db, test_user):
        from app.models.clover import CloverCredential
        from app.models.square import SquareCredential
        from app.services.clover import clover_service
        from app.services.square import square_service

        for provider in ("square", "clover"):
            # Not connected: still a clean 200.
            r = client.delete(f"/api/v1/integrations/{provider}", headers=auth_headers)
            assert r.status_code == 200 and r.json()["disconnected"] is True
        db.add(SquareCredential(user_id=test_user.id, **_cred_fields(SquareCredential)))
        db.add(CloverCredential(user_id=test_user.id, **_cred_fields(CloverCredential)))
        db.commit()
        assert square_service._get_credential(db, test_user.id) is not None
        assert client.delete("/api/v1/integrations/square", headers=auth_headers).status_code == 200
        assert client.delete("/api/v1/integrations/clover", headers=auth_headers).status_code == 200
        db.expire_all()
        assert square_service._get_credential(db, test_user.id) is None
        assert clover_service._get_credential(db, test_user.id) is None
        assert client.get("/api/v1/integrations/square/status", headers=auth_headers).json()["connected"] is False


def _cred_fields(model) -> dict:
    """Fill the credential's required string columns with dummy values."""
    fields = {}
    for col in model.__table__.columns:
        if col.name in ("id", "user_id", "created_at", "updated_at") or col.nullable or col.default is not None \
                or col.server_default is not None:
            continue
        fields[col.name] = "test-value"
    return fields
