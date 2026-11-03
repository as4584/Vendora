"""PDF receipt for an in-person checkout: GET /transactions/order/{id}/receipt.pdf."""
import uuid
from decimal import Decimal
from unittest.mock import patch

from app.models.inventory import InventoryItem
from app.services.invoice_pdf import generate_receipt_pdf

API = "/api/v1"
D = Decimal


def _item(db, user, name, qty=3):
    item = InventoryItem(user_id=user.id, name=name, quantity=qty, expected_sell_price=D("50.00"),
                         buy_price=D("10.00"))
    db.add(item)
    db.commit()
    return item


def _split_order(client, headers, db, user):
    a = _item(db, user, "Jordan 4 Bred")
    b = _item(db, user, "Café Tee")  # non-Latin-1 friendly name must not crash the PDF
    resp = client.post(f"{API}/transactions/order", json={
        "lines": [
            {"item_id": str(a.id), "unit_price": "200.00", "quantity": 1},
            {"item_id": str(b.id), "unit_price": "25.00", "quantity": 2},
        ],
        "discount_amount": "10.00",
        "tax_rate": "6.625",
        "payments": [{"method": "cash", "amount": "200.00"}, {"method": "card", "amount": "55.90"}],
    }, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestReceiptPdf:
    def test_returns_a_pdf(self, client, auth_headers, db, test_user):
        order = _split_order(client, auth_headers, db, test_user)
        resp = client.get(f"{API}/transactions/order/{order['order_id']}/receipt.pdf", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"] == "application/pdf"
        assert resp.content[:4] == b"%PDF"
        assert "receipt-R-" in resp.headers["content-disposition"]

    def test_passes_lines_totals_and_payment_parts(self, client, auth_headers, db, test_user):
        order = _split_order(client, auth_headers, db, test_user)
        with patch("app.routers.transactions.generate_receipt_pdf", return_value=b"%PDF-x") as gen:
            resp = client.get(f"{API}/transactions/order/{order['order_id']}/receipt.pdf",
                              headers=auth_headers)
        assert resp.status_code == 200
        kw = gen.call_args.kwargs
        names = sorted(line["name"] for line in kw["lines"])
        assert names == ["Café Tee", "Jordan 4 Bred"]
        tee = next(line for line in kw["lines"] if line["name"] == "Café Tee")
        assert tee["quantity"] == 2 and tee["unit_price"] == D("25.00") and tee["line_total"] == D("50.00")
        assert kw["subtotal"] == D("250.00")
        assert kw["discount"] == D("10.00")
        assert kw["total"] == D(order["total_amount"])
        assert sorted((p["method"], p["amount"]) for p in kw["payments"]) == [
            ("card", D("55.90")), ("cash", D("200.00"))]
        assert kw["user"].id == test_user.id

    def test_single_method_sale_shows_that_method(self, client, auth_headers, db, test_user):
        item = _item(db, test_user, "Dunk")
        order = client.post(f"{API}/transactions/order", json={
            "lines": [{"item_id": str(item.id), "unit_price": "90.00", "quantity": 1}], "method": "venmo",
        }, headers=auth_headers).json()
        with patch("app.routers.transactions.generate_receipt_pdf", return_value=b"%PDF-x") as gen:
            client.get(f"{API}/transactions/order/{order['order_id']}/receipt.pdf", headers=auth_headers)
        assert gen.call_args.kwargs["payments"] == [{"method": "venmo", "amount": D("90.00")}]

    def test_unknown_order_is_404(self, client, auth_headers):
        resp = client.get(f"{API}/transactions/order/{uuid.uuid4()}/receipt.pdf", headers=auth_headers)
        assert resp.status_code == 404

    def test_requires_auth(self, client):
        assert client.get(f"{API}/transactions/order/{uuid.uuid4()}/receipt.pdf").status_code in (401, 403)

    def test_generator_handles_many_lines(self, test_user):
        lines = [{"name": f"Card #{i}", "size": "10" if i % 2 else None, "quantity": 1,
                  "unit_price": D("5.00"), "line_total": D("5.00")} for i in range(40)]
        out = generate_receipt_pdf(user=test_user, receipt_number="R-1", created_at=None, lines=lines,
                                   subtotal=D("200.00"), discount=D("0"), tax=D("0"), total=D("200.00"),
                                   payments=[{"method": "cash", "amount": D("200.00")}])
        assert out.startswith(b"%PDF")
