import pytest

from app.config import settings


@pytest.fixture()
def web_dir(tmp_path, monkeypatch):
    (tmp_path / "secret.txt").write_text("nope")
    tmp_path = tmp_path / "web"
    tmp_path.mkdir()
    (tmp_path / "index.html").write_text("<html>VENDORA_WEB</html>")
    (tmp_path / "_expo" / "static" / "js").mkdir(parents=True)
    (tmp_path / "_expo" / "static" / "js" / "app.js").write_text("console.log(1)")
    monkeypatch.setattr(settings, "WEB_DIST_DIR", str(tmp_path))
    return tmp_path


def test_root_and_spa_fallback(client, web_dir):
    assert "VENDORA_WEB" in client.get("/").text
    assert "VENDORA_WEB" in client.get("/inventory/123").text


def test_static_asset_cached(client, web_dir):
    resp = client.get("/_expo/static/js/app.js")
    assert resp.status_code == 200 and "immutable" in resp.headers["cache-control"]


def test_api_and_pages_not_shadowed(client, web_dir):
    assert client.get("/api/v1/nope").status_code == 404
    assert client.get("/api/v1/health").json()["status"] == "ok"
    assert "Privacy Policy" in client.get("/privacy").text


def test_traversal_blocked(client, web_dir):
    assert "nope" not in client.get("/..%2Fsecret.txt").text


def test_disabled_without_dir(client, monkeypatch):
    monkeypatch.setattr(settings, "WEB_DIST_DIR", "")
    assert client.get("/").status_code == 404
