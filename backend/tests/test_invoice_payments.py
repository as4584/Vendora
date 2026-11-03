"""Invoice payments + offline-create replay.

Covers: partial/full payments, overpay rejection, status transitions,
cost of goods booked exactly once across payments, idempotent replays,
and the PDF balance due.
"""
from decimal import Decimal

from app.models.transaction import Transaction
from app.services.invoice import allocate


def _item(client, headers, buy="40.00", qty=1):
    return client.post("/api/v1/inventory", json={
        "name": "Dunk Low Panda",
        "category": "sneakers",
        "buy_price": buy,
        "quantity": qty,
    }, headers=headers).json()


def _invoice(client, headers, item_id=None, price="100.00", **extra):
    line = {"description": "Dunk Low Panda", "quantity": 1, "unit_price": price}
    if item_id:
        line["inventory_item_id"] = item_id
    resp = client.post("/api/v1/invoices", json={
        "customer_name": "Show Buyer", "items": [line], **extra,
    }, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _pay(client, headers, invoice_id, amount, method="cash", **extra):
    return client.post(
        f"/api/v1/invoices/{invoice_id}/payments",
        json={"amount": amount, "method": method, **extra},
        headers=headers,
    )


class TestOfflineCreateReplay:
    def test_same_client_request_id_returns_same_invoice(self, client, auth_headers):
        first = _invoice(client, auth_headers, client_request_id="offline-inv-0001")
        again = client.post("/api/v1/invoices", json={
            "customer_name": "Show Buyer",
            "items": [{"description": "Dunk Low Panda", "quantity": 1, "unit_price": "100.00"}],
            "client_request_id": "offline-inv-0001",
        }, headers=auth_headers)
        assert again.status_code == 201
        assert again.json()["id"] == first["id"]
        assert again.json()["invoice_number"] == first["invoice_number"]
        listed = client.get("/api/v1/invoices", headers=auth_headers).json()
        assert listed["total"] == 1

    def test_replay_key_is_per_user(self, client, auth_headers, second_auth_headers):
        a = _invoice(client, auth_headers, client_request_id="shared-key-123")
        b = _invoice(client, second_auth_headers, client_request_id="shared-key-123")
        assert a["id"] != b["id"]
        assert b["invoice_number"] == "INV0001"

    def test_new_invoice_reports_zero_paid(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        assert inv["amount_paid"] == "0.00"
        assert inv["balance_due"] == "100.00"
        assert inv["payments"] == []


class TestPaymentMath:
    def test_partial_then_full(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        r1 = _pay(client, auth_headers, inv["id"], "30.00", "cash", note="deposit")
        assert r1.status_code == 201, r1.text
        body = r1.json()
        assert body["status"] == "partially_paid"
        assert body["amount_paid"] == "30.00"
        assert body["balance_due"] == "70.00"
        assert body["payments"][0]["note"] == "deposit"

        r2 = _pay(client, auth_headers, inv["id"], "70.00", "card")
        assert r2.json()["status"] == "paid"
        assert r2.json()["balance_due"] == "0.00"
        assert [p["method"] for p in r2.json()["payments"]] == ["cash", "card"]

    def test_full_in_one_payment(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        r = _pay(client, auth_headers, inv["id"], "100.00", "zelle")
        assert r.json()["status"] == "paid"

    def test_overpay_rejected(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        _pay(client, auth_headers, inv["id"], "60.00")
        r = _pay(client, auth_headers, inv["id"], "40.01")
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "overpayment"
        assert r.json()["detail"]["balance_due"] == "40.00"

    def test_zero_and_bad_method_rejected(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        assert _pay(client, auth_headers, inv["id"], "0.00").status_code == 422
        assert _pay(client, auth_headers, inv["id"], "5.00", "bitcoin").status_code == 422

    def test_all_methods_accepted(self, client, auth_headers):
        methods = ["cash", "card", "zelle", "venmo", "cashapp", "paypal", "stripe", "other"]
        inv = _invoice(client, auth_headers, price="8.00")
        for m in methods:
            assert _pay(client, auth_headers, inv["id"], "1.00", m).status_code == 201

    def test_payment_replay_is_idempotent(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        _pay(client, auth_headers, inv["id"], "25.00", client_request_id="pay-req-0001")
        r = _pay(client, auth_headers, inv["id"], "25.00", client_request_id="pay-req-0001")
        assert r.status_code == 201
        assert r.json()["amount_paid"] == "25.00"
        assert len(r.json()["payments"]) == 1

    def test_other_users_invoice_404(self, client, auth_headers, second_auth_headers):
        inv = _invoice(client, auth_headers)
        assert _pay(client, second_auth_headers, inv["id"], "5.00").status_code == 404

    def test_allocate_sums_exactly(self):
        parts = allocate(Decimal("10.00"), [Decimal("1"), Decimal("1"), Decimal("1")])
        assert sum(parts) == Decimal("10.00")
        assert parts == [Decimal("3.33"), Decimal("3.33"), Decimal("3.34")]
        assert allocate(Decimal("5.00"), [Decimal("0"), Decimal("0")]) == [Decimal("0.00"), Decimal("5.00")]
        assert allocate(Decimal("5.00"), []) == []


class TestStatusTransitions:
    def test_cancelled_cannot_be_paid(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        client.patch(f"/api/v1/invoices/{inv['id']}/status", json={"status": "sent"}, headers=auth_headers)
        client.patch(f"/api/v1/invoices/{inv['id']}/status", json={"status": "cancelled"}, headers=auth_headers)
        r = _pay(client, auth_headers, inv["id"], "5.00")
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "invoice_not_payable"

    def test_paid_cannot_take_more(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        _pay(client, auth_headers, inv["id"], "100.00")
        assert _pay(client, auth_headers, inv["id"], "1.00").status_code == 400

    def test_partially_paid_cannot_cancel_or_edit(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        _pay(client, auth_headers, inv["id"], "10.00")
        r = client.patch(f"/api/v1/invoices/{inv['id']}/status", json={"status": "cancelled"}, headers=auth_headers)
        assert r.status_code == 400
        edit = client.put(f"/api/v1/invoices/{inv['id']}", json={
            "customer_name": "X",
            "items": [{"description": "Y", "quantity": 1, "unit_price": "1.00"}],
        }, headers=auth_headers)
        assert edit.status_code == 400

    def test_mark_paid_records_remaining_balance(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        _pay(client, auth_headers, inv["id"], "40.00")
        r = client.patch(f"/api/v1/invoices/{inv['id']}/status", json={"status": "paid"}, headers=auth_headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "paid"
        assert body["amount_paid"] == "100.00"
        assert [p["amount"] for p in body["payments"]] == ["40.00", "60.00"]

    def test_stripe_intent_refused_after_partial(self, client, auth_headers):
        inv = _invoice(client, auth_headers)
        _pay(client, auth_headers, inv["id"], "40.00")
        assert client.post(f"/api/v1/invoices/{inv['id']}/pay", headers=auth_headers).status_code == 409


class TestCostAndStock:
    def test_cost_booked_once_across_partials(self, client, auth_headers, db):
        item = _item(client, auth_headers, buy="40.00")
        inv = _invoice(client, auth_headers, item_id=item["id"], price="100.00")
        for amt in ("33.33", "33.33", "33.34"):
            assert _pay(client, auth_headers, inv["id"], amt).status_code == 201
        txns = db.query(Transaction).filter(Transaction.invoice_id == inv["id"]).all()
        assert len(txns) == 3
        assert sum(t.gross_amount for t in txns) == Decimal("100.00")
        assert sum(t.cost_amount for t in txns) == Decimal("40.00")
        assert sum(t.quantity for t in txns) == 1
        stock = client.get(f"/api/v1/inventory/{item['id']}", headers=auth_headers).json()
        assert stock["quantity"] == 0

    def test_buy_price_edit_after_first_payment_does_not_move_cost(self, client, auth_headers, db):
        item = _item(client, auth_headers, buy="40.00")
        inv = _invoice(client, auth_headers, item_id=item["id"], price="100.00")
        _pay(client, auth_headers, inv["id"], "50.00")
        client.put(f"/api/v1/inventory/{item['id']}", json={"buy_price": "90.00"}, headers=auth_headers)
        _pay(client, auth_headers, inv["id"], "50.00")
        txns = db.query(Transaction).filter(Transaction.invoice_id == inv["id"]).all()
        assert sum(t.cost_amount for t in txns) == Decimal("40.00")

    def test_mark_paid_without_payments_books_full_cost(self, client, auth_headers, db):
        item = _item(client, auth_headers, buy="40.00")
        inv = _invoice(client, auth_headers, item_id=item["id"], price="100.00")
        client.patch(f"/api/v1/invoices/{inv['id']}/status", json={"status": "sent"}, headers=auth_headers)
        client.patch(f"/api/v1/invoices/{inv['id']}/status", json={"status": "paid"}, headers=auth_headers)
        txns = db.query(Transaction).filter(Transaction.invoice_id == inv["id"]).all()
        assert len(txns) == 1
        assert txns[0].cost_amount == Decimal("40.00")
        assert txns[0].gross_amount == Decimal("100.00")


class TestPdfBalance:
    def test_pdf_shows_partial_balance(self, client, auth_headers, db, test_user):
        from app.models.invoice import Invoice, InvoiceItem
        from app.services.invoice_pdf import generate_invoice_pdf

        inv = _invoice(client, auth_headers)
        _pay(client, auth_headers, inv["id"], "30.00")
        invoice = db.query(Invoice).filter(Invoice.id == inv["id"]).one()
        items = db.query(InvoiceItem).filter(InvoiceItem.invoice_id == invoice.id).all()
        captured: list[str] = []
        import fpdf

        original = fpdf.FPDF.cell

        def spy(self, *args, **kwargs):
            text = kwargs.get("text", kwargs.get("txt", args[2] if len(args) > 2 else ""))
            captured.append(str(text))
            return original(self, *args, **kwargs)

        fpdf.FPDF.cell = spy
        try:
            pdf = generate_invoice_pdf(invoice, items, test_user, invoice.invoice_number)
        finally:
            fpdf.FPDF.cell = original
        assert pdf[:4] == b"%PDF"
        assert "$30.00" in captured
        assert "$70.00" in captured
        assert "BALANCE DUE" in captured
