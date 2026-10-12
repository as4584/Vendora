"""Every API response carries security headers; oversized bodies are refused;
production does not publish the interactive API docs."""
import asyncio
import importlib

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.http_hardening import HardeningMiddleware, SECURITY_HEADERS


def test_security_headers_on_api_responses(client):
    for path in ("/api/v1/health", "/api/v1/sellers/abc", "/api/v1/does-not-exist"):
        resp = client.get(path)
        for name in SECURITY_HEADERS:
            assert name.decode() in resp.headers, (path, name)
    assert client.get("/api/v1/health").headers["x-frame-options"] == "DENY"


def _echo_app(max_bytes):
    app = FastAPI()

    @app.post("/echo")
    async def echo(request: Request):
        return {"n": len(await request.body())}

    app.add_middleware(HardeningMiddleware, max_bytes=max_bytes)
    return TestClient(app)


def test_declared_oversized_body_is_refused():
    c = _echo_app(10)
    assert c.post("/echo", content=b"x" * 10).json() == {"n": 10}
    resp = c.post("/echo", content=b"x" * 11)
    assert resp.status_code == 413
    assert resp.headers["x-content-type-options"] == "nosniff"
    bad = c.post("/echo", content=b"x", headers={"content-length": "abc"})
    assert bad.status_code in (400, 413)


def test_streamed_oversized_body_is_refused():
    c = _echo_app(10)
    resp = c.post("/echo", content=iter([b"x" * 6, b"x" * 6]))
    assert resp.status_code == 413


def test_invalid_content_length_header_is_refused():
    """Call the middleware directly so no HTTP client rewrites the header."""
    sent = []

    async def app(scope, receive, send):  # pragma: no cover - must not be reached
        raise AssertionError("app should not run")

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/", "headers": [(b"content-length", b"abc")]}
    asyncio.run(HardeningMiddleware(app)(scope, receive, send))
    assert sent[0]["status"] == 413


def test_non_http_scopes_pass_through():
    seen = []

    async def app(scope, receive, send):
        seen.append(scope["type"])

    asyncio.run(HardeningMiddleware(app)({"type": "lifespan"}, None, None))
    assert seen == ["lifespan"]


def test_docs_hidden_in_production(monkeypatch):
    import app.main as main_module
    from app.config import settings

    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    try:
        prod = importlib.reload(main_module)
        c = TestClient(prod.app)
        for path in ("/api/v1/docs", "/api/v1/redoc", "/api/v1/openapi.json"):
            assert c.get(path).status_code == 404, path
    finally:
        monkeypatch.setattr(settings, "ENVIRONMENT", "testing")
        importlib.reload(main_module)


def test_docs_available_outside_production(client):
    assert client.get("/api/v1/openapi.json").status_code == 200
