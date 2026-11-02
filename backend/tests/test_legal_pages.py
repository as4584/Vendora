def test_privacy_page(client):
    resp = client.get("/privacy")
    assert resp.status_code == 200
    assert "Vendora Privacy Policy" in resp.text and "Delete Account" in resp.text
    assert "script-src" not in resp.headers["content-security-policy"]


def test_support_page(client):
    resp = client.get("/support")
    assert resp.status_code == 200 and "Restore Purchases" in resp.text
