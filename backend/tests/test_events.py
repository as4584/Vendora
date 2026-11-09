"""First-party analytics: client events, server funnel milestones, owner funnel."""
from app.config import settings
from app.models.app_event import AppEvent


def _names(db, user_id):
    return [e.name for e in db.query(AppEvent).filter(AppEvent.user_id == user_id).all()]


def test_client_event_recorded_and_props_cleaned(client, db, auth_headers, test_user):
    r = client.post(
        "/api/v1/events",
        json={"name": "paywall_view", "props": {"source": "inventory", "nested": {"x": 1}, "n": 3}},
        headers=auth_headers,
    )
    assert r.status_code == 204
    ev = db.query(AppEvent).filter(AppEvent.user_id == test_user.id).one()
    assert ev.name == "paywall_view"
    assert ev.props == {"source": "inventory", "n": 3}


def test_unknown_event_rejected(client, auth_headers):
    r = client.post("/api/v1/events", json={"name": "email_address"}, headers=auth_headers)
    assert r.status_code == 422


def test_events_require_auth(client):
    assert client.post("/api/v1/events", json={"name": "app_open"}).status_code == 401


def test_signup_tracked(client, db):
    r = client.post(
        "/api/v1/auth/register",
        json={"email": "funnel@example.com", "password": "Sup3rSecret!!", "business_name": "F"},
    )
    assert r.status_code == 201
    assert _names(db, r.json()["id"]) == ["signup"]


def test_first_item_tracked_once(client, db, auth_headers, test_user):
    for i in range(2):
        r = client.post(
            "/api/v1/inventory",
            json={"name": f"Shoe {i}", "buy_price": "10.00", "quantity": 1},
            headers=auth_headers,
        )
        assert r.status_code == 201, r.text
    assert _names(db, test_user.id).count("item_created") == 1


def test_funnel_hidden_without_token(client, monkeypatch):
    monkeypatch.setattr(settings, "ANALYTICS_ADMIN_TOKEN", "")
    assert client.get("/api/v1/events/funnel").status_code == 404


def test_funnel_with_token(client, db, auth_headers, monkeypatch):
    monkeypatch.setattr(settings, "ANALYTICS_ADMIN_TOKEN", "owner-secret")
    client.post("/api/v1/events", json={"name": "paywall_view"}, headers=auth_headers)
    assert client.get("/api/v1/events/funnel", headers={"X-Analytics-Token": "wrong"}).status_code == 404
    r = client.get("/api/v1/events/funnel", headers={"X-Analytics-Token": "owner-secret"})
    assert r.status_code == 200
    steps = {s["name"]: s["users"] for s in r.json()["steps"]}
    assert steps["paywall_view"] == 1
