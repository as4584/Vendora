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


def test_concurrent_replay_returns_the_winning_sale(client, auth_headers, db, monkeypatch):
    """If another request inserts the same client_request_id between our
    lookup and insert, the unique index fires and we return its sale."""
    from sqlalchemy.exc import IntegrityError

    from app.routers import transactions as txn_router

    winner = client.post(
        "/api/v1/transactions", json=_sale(client_request_id="ob_race_999999"), headers=auth_headers
    ).json()

    calls = {"n": 0}
    real_find = txn_router._find_client_request

    def find(db_, user_id, reference):
        calls["n"] += 1
        return None if calls["n"] == 1 else real_find(db_, user_id, reference)

    def flush_conflict(*args, **kwargs):
        raise IntegrityError("insert", {}, Exception("duplicate key"))

    monkeypatch.setattr(txn_router, "_find_client_request", find)
    monkeypatch.setattr(db, "rollback", lambda: None)
    monkeypatch.setattr(db, "flush", flush_conflict)
    resp = client.post(
        "/api/v1/transactions", json=_sale(client_request_id="ob_race_999999"), headers=auth_headers
    )
    assert resp.status_code == 201
    assert resp.json()["id"] == winner["id"]
