"""The rate limiter must key on the visitor, not the Cloudflare tunnel."""
from starlette.requests import Request

from app.rate_limit import client_ip


def _request(headers: dict[str, str]) -> Request:
    return Request({
        "type": "http",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": ("172.18.0.5", 50000),
    })


def test_uses_cloudflare_visitor_ip():
    assert client_ip(_request({"CF-Connecting-IP": "203.0.113.7"})) == "203.0.113.7"


def test_falls_back_to_socket_address():
    assert client_ip(_request({})) == "172.18.0.5"
