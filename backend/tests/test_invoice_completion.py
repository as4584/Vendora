"""Completion coverage for invoice update, payment, and PDF routes."""
import pytest
from datetime import datetime, timezone
from decimal import Decimal
from fastapi import HTTPException

from app.models.inventory import InventoryItem
from app.models.invoice import Invoice, InvoiceItem
from app.services import invoice as invoice_service


class TestInvoiceServiceEdges:
    def test_variant_availability_reports_low_and_missing_sizes(self):
        item = InventoryItem(
            name="Sized Item",
            quantity=2,
            status="in_stock",
            custom_attributes={"variants": [{"size": "M", "quantity": 1}]},
        )
        with pytest.raises(HTTPException) as low:
            invoice_service.check_invoice_item_availability(item, 2, "M")
        assert low.value.detail["error"] == "insufficient_size_stock"
        with pytest.raises(HTTPException) as missing:
            invoice_service.check_invoice_item_availability(item, 1, "L")
        assert missing.value.detail["error"] == "size_not_available"
        invoice_service._deduct_variant_quantity(item, "L", 1)
        assert item.custom_attributes["variants"][0]["quantity"] == 1

    def test_payment_fallback_and_deleted_item_paths(self, db, test_user, monkeypatch):
        active = InventoryItem(user_id=test_user.id, name="Active", quantity=1, status="in_stock")
        deleted = InventoryItem(
            user_id=test_user.id,
            name="Deleted",
            quantity=1,
            status="in_stock",
            deleted_at=datetime.now(timezone.utc),
        )
        archived = InventoryItem(user_id=test_user.id, name="Archived", quantity=1, status="archived")
        db.add_all([active, deleted, archived])
        db.flush()
        invoice = Invoice(
            user_id=test_user.id,
            customer_name="Coverage Buyer",
            status="paid",
            subtotal=Decimal("20.00"),
            total=Decimal("20.00"),
        )
        db.add(invoice)
        db.flush()
        db.add_all([
            InvoiceItem(
                invoice_id=invoice.id, inventory_item_id=active.id, description="Active",
                quantity=1, unit_price=Decimal("10.00"), line_total=Decimal("10.00"),
            ),
            InvoiceItem(
                invoice_id=invoice.id, inventory_item_id=deleted.id, description="Deleted",
                quantity=1, unit_price=Decimal("10.00"), line_total=Decimal("10.00"),
            ),
            InvoiceItem(
                invoice_id=invoice.id, inventory_item_id=archived.id, description="Archived",
                quantity=1, unit_price=Decimal("10.00"), line_total=Decimal("10.00"),
            ),
        ])
        db.commit()

        def fail(*args, **kwargs):
            raise HTTPException(status_code=409, detail="stock failure")

        monkeypatch.setattr(invoice_service, "deduct_stock", fail)
        invoice_service.process_invoice_payment(invoice, db)
        db.refresh(active)
        assert active.status == "sold"
        assert active.actual_sell_price == Decimal("10.00")
        db.refresh(archived)
        assert archived.status == "archived"


class TestInvoiceCrudCompletion:
    def _create(self, client, headers, **overrides):
        payload = {
            "customer_name": "Original Buyer",
            "customer_email": "old@example.com",
            "items": [{"description": "Original line", "quantity": 1, "unit_price": "20.00"}],
            "notes": "old note",
        }
        payload.update(overrides)
        response = client.post("/api/v1/invoices", json=payload, headers=headers)
        assert response.status_code == 201
        return response.json()

    def test_get_update_and_filter_invoice(self, client, auth_headers):
        invoice = self._create(client, auth_headers)
        fetched = client.get(f"/api/v1/invoices/{invoice['id']}", headers=auth_headers)
        assert fetched.status_code == 200

        updated = client.put(
            f"/api/v1/invoices/{invoice['id']}",
            json={
                "customer_name": "Updated Buyer",
                "customer_email": "new@example.com",
                "items": [
                    {"description": "Updated line", "quantity": 2, "unit_price": "25.00"},
                    {"description": "Shipping box", "quantity": 1, "unit_price": "5.00"},
                ],
                "tax": "2.00",
                "shipping": "3.00",
                "discount": "1.00",
                "notes": "updated note",
            },
            headers=auth_headers,
        )
        assert updated.status_code == 200
        body = updated.json()
        assert body["customer_name"] == "Updated Buyer"
        assert body["total"] == "59.00"
        assert len(body["items"]) == 2

        sent = client.patch(
            f"/api/v1/invoices/{invoice['id']}/status",
            json={"status": "sent"},
            headers=auth_headers,
        )
        assert sent.status_code == 200
        filtered = client.get("/api/v1/invoices?status=sent", headers=auth_headers)
        assert filtered.status_code == 200
        assert filtered.json()["total"] == 1

    def test_update_with_inventory_line_and_missing_inventory_rejected(self, client, auth_headers):
        inventory = client.post(
            "/api/v1/inventory",
            json={"name": "Linked item", "quantity": 3, "expected_sell_price": "30.00"},
            headers=auth_headers,
        ).json()
        invoice = self._create(client, auth_headers)
        response = client.put(
            f"/api/v1/invoices/{invoice['id']}",
            json={
                "customer_name": "Linked Buyer",
                "items": [{
                    "description": "Linked item",
                    "quantity": 2,
                    "unit_price": "30.00",
                    "inventory_item_id": inventory["id"],
                }],
            },
            headers=auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["items"][0]["inventory_item_id"] == inventory["id"]

        missing = client.put(
            f"/api/v1/invoices/{invoice['id']}",
            json={
                "customer_name": "Missing Buyer",
                "items": [{
                    "description": "Missing",
                    "quantity": 1,
                    "unit_price": "10.00",
                    "inventory_item_id": "00000000-0000-0000-0000-000000000001",
                }],
            },
            headers=auth_headers,
        )
        assert missing.status_code == 404

    @pytest.mark.parametrize("method,path", [
        ("get", "/api/v1/invoices/00000000-0000-0000-0000-000000000001"),
        ("put", "/api/v1/invoices/00000000-0000-0000-0000-000000000001"),
        ("patch", "/api/v1/invoices/00000000-0000-0000-0000-000000000001/status"),
        ("post", "/api/v1/invoices/00000000-0000-0000-0000-000000000001/pay"),
        ("get", "/api/v1/invoices/00000000-0000-0000-0000-000000000001/pdf"),
    ])
    def test_missing_invoice_endpoints(self, client, auth_headers, method, path):
        payload = None
        if method == "put":
            payload = {"customer_name": "Missing", "items": [{"description": "X", "quantity": 1, "unit_price": "1"}]}
        elif method == "patch":
            payload = {"status": "sent"}
        request = getattr(client, method)
        response = request(path, json=payload, headers=auth_headers) if payload else request(path, headers=auth_headers)
        assert response.status_code == 404

    @pytest.mark.parametrize("terminal_status", ["paid", "cancelled"])
    def test_terminal_invoice_cannot_be_edited(self, client, auth_headers, terminal_status):
        invoice = self._create(client, auth_headers)
        client.patch(f"/api/v1/invoices/{invoice['id']}/status", json={"status": "sent"}, headers=auth_headers)
        client.patch(f"/api/v1/invoices/{invoice['id']}/status", json={"status": terminal_status}, headers=auth_headers)
        response = client.put(
            f"/api/v1/invoices/{invoice['id']}",
            json={"customer_name": "Nope", "items": [{"description": "X", "quantity": 1, "unit_price": "1"}]},
            headers=auth_headers,
        )
        assert response.status_code == 400

    def test_payment_endpoint_delegates_to_stripe_service(self, client, auth_headers, monkeypatch):
        invoice = self._create(client, auth_headers)
        observed = {}

        def fake_payment(db, invoice_model, user):
            observed.update(invoice_id=str(invoice_model.id), user_id=str(user.id))
            return {"client_secret": "pi_secret", "payment_intent_id": "pi_1", "amount": 2000}

        monkeypatch.setattr("app.routers.invoices.create_payment_intent", fake_payment)
        response = client.post(f"/api/v1/invoices/{invoice['id']}/pay", headers=auth_headers)
        assert response.status_code == 200
        assert response.json()["client_secret"] == "pi_secret"
        assert observed["invoice_id"] == invoice["id"]

    def test_pdf_endpoint_returns_base64_and_sequence(self, client, auth_headers, monkeypatch):
        self._create(client, auth_headers, customer_name="First")
        second = self._create(client, auth_headers, customer_name="Second")
        observed = {}

        def fake_pdf(invoice_model, items, user, number):
            observed.update(invoice_id=str(invoice_model.id), count=len(items), number=number)
            return b"%PDF-test"

        monkeypatch.setattr("app.routers.invoices.generate_invoice_pdf", fake_pdf)
        response = client.get(f"/api/v1/invoices/{second['id']}/pdf", headers=auth_headers)
        assert response.status_code == 200
        assert response.json()["filename"] == "invoice-INV0002.pdf"
        assert response.json()["pdf_base64"] == "JVBERi10ZXN0"
        assert observed == {"invoice_id": second["id"], "count": 1, "number": "INV0002"}
