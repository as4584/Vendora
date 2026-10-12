"""Offline quick sales replayed by the app must be recorded once."""
from app.models.transaction import Transaction


def _sale(**extra):
    return {"method": "cash", "gross_amount": "25.00", **extra}


def test_replayed_client_request_creates_one_sale(client, auth_headers, db):
    first = client.post("/api/v1/transactions", json=_sale(client_request_id="ob_replay_abc123"), headers=auth_headers)
    second = client.post("/api/v1/transactions", json=_sale(client_request_id="ob_replay_abc123"), headers=auth_headers)
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert db.query(Transaction).filter(Transaction.external_reference_id == "ob_replay_abc123").count() == 1


def test_different_client_requests_create_separate_sales(client, auth_headers):
    a = client.post("/api/v1/transactions", json=_sale(client_request_id="ob_one_111111"), headers=auth_headers)
    b = client.post("/api/v1/transactions", json=_sale(client_request_id="ob_two_222222"), headers=auth_headers)
    assert a.json()["id"] != b.json()["id"]


def test_sales_without_client_request_id_are_unchanged(client, auth_headers):
    a = client.post("/api/v1/transactions", json=_sale(), headers=auth_headers)
    b = client.post("/api/v1/transactions", json=_sale(), headers=auth_headers)
    assert a.status_code == b.status_code == 201
    assert a.json()["id"] != b.json()["id"]


def test_client_request_id_is_validated(client, auth_headers):
    bad = client.post("/api/v1/transactions", json=_sale(client_request_id="x"), headers=auth_headers)
    assert bad.status_code == 422
