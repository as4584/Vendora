"""Market pricing (eBay comps + price suggestions) is a Pro feature."""


def _make_item(client, headers):
    r = client.post("/api/v1/inventory", json={"name": "Jordan 1"}, headers=headers)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_free_user_gets_pro_required(client, auth_headers):
    item_id = _make_item(client, auth_headers)
    for path in (f"/api/v1/inventory/{item_id}/pricing-suggestion",
                 f"/api/v1/inventory/{item_id}/ebay-comps",
                 "/api/v1/integrations/ebay/comps?q=jordan"):
        r = client.get(path, headers=auth_headers)
        assert r.status_code == 403, path
        assert r.json()["detail"]["error"] == "pro_required"


def test_pro_user_gets_suggestion(client, auth_headers, test_user, db):
    test_user.subscription_tier = "pro"
    db.flush()
    item_id = _make_item(client, auth_headers)
    r = client.get(f"/api/v1/inventory/{item_id}/pricing-suggestion", headers=auth_headers)
    assert r.status_code == 200, r.text


def test_early_free_user_keeps_pricing_during_grace(client, auth_headers, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "PRICING_GRACE_CUTOFF", "2999-01-01")
    monkeypatch.setattr(settings, "PRICING_GRACE_UNTIL", "2999-02-01")
    item_id = _make_item(client, auth_headers)
    r = client.get(f"/api/v1/inventory/{item_id}/pricing-suggestion", headers=auth_headers)
    assert r.status_code == 200, r.text


def test_grace_expired_or_new_user_is_gated(client, auth_headers, monkeypatch):
    from app.config import settings
    item_id = _make_item(client, auth_headers)
    url = f"/api/v1/inventory/{item_id}/pricing-suggestion"
    monkeypatch.setattr(settings, "PRICING_GRACE_CUTOFF", "2999-01-01")
    monkeypatch.setattr(settings, "PRICING_GRACE_UNTIL", "2000-01-01")  # ended
    assert client.get(url, headers=auth_headers).status_code == 403
    monkeypatch.setattr(settings, "PRICING_GRACE_CUTOFF", "2000-01-01")  # user signed up after cutoff
    monkeypatch.setattr(settings, "PRICING_GRACE_UNTIL", "2999-01-01")
    assert client.get(url, headers=auth_headers).status_code == 403
