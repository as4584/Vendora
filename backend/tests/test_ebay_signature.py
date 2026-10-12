"""eBay deletion notices are acted on only with a valid x-ebay-signature."""
import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from app.services import ebay_signature
from tests.ebay_signing import PUBLIC_PEM, TEST_KID, sign_header, signed_ebay_post

URL = "/api/v1/integrations/ebay/deletion"


def test_missing_signature_is_rejected(client):
    resp = client.post(URL, json={"notification": {"data": {"username": "x"}}})
    assert resp.status_code == 412


def test_malformed_header_is_rejected(client):
    assert signed_ebay_post(client, {"a": 1}, header="%%%not-base64").status_code == 412
    no_kid = base64.b64encode(json.dumps({"signature": "abc"}).encode()).decode()
    assert signed_ebay_post(client, {"a": 1}, header=no_kid).status_code == 412


def test_tampered_body_is_rejected(client):
    header = sign_header(b'{"notification": {"data": {"username": "someone"}}}')
    assert signed_ebay_post(client, {"notification": {"data": {"username": "victim"}}}, header=header).status_code == 412


def test_signature_from_another_key_is_rejected(client):
    body = b"{}"
    header = sign_header(body, key=ec.generate_private_key(ec.SECP256R1()))
    assert signed_ebay_post(client, body, header=header).status_code == 412


def test_key_fetch_network_failure_returns_503(client):
    async def boom(service, kid):
        raise httpx.ConnectError("down")

    body = b"{}"
    with patch("app.services.ebay_signature.fetch_public_key", boom):
        resp = client.post(URL, content=body, headers={"x-ebay-signature": sign_header(body)})
    assert resp.status_code == 503


def test_verify_rejects_bad_digest_and_key_type():
    fields = ebay_signature.parse_header(sign_header(b"{}"))
    with pytest.raises(ebay_signature.SignatureError):
        ebay_signature.verify(b"{}", fields, PUBLIC_PEM, "MD5")
    with pytest.raises(ebay_signature.SignatureError):
        ebay_signature.verify(b"{}", fields, "-----BEGIN PUBLIC KEY-----garbage-----END PUBLIC KEY-----")
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    rsa_pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    with pytest.raises(ebay_signature.SignatureError, match="key type"):
        ebay_signature.verify(b"{}", fields, rsa_pem)


class _FakeClient:
    def __init__(self, token_status=200, key_status=200):
        self.token_status, self.key_status = token_status, key_status
        self.calls = []

    def __call__(self, *a, **k):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, **k):
        self.calls.append(("post", url))
        return httpx.Response(self.token_status, json={"access_token": "app-token"})

    async def get(self, url, **k):
        self.calls.append(("get", url))
        return httpx.Response(self.key_status, json={"key": PUBLIC_PEM, "digest": "SHA1"})


SERVICE = SimpleNamespace(
    token_url="https://api.ebay.test/token",
    api_base="https://api.ebay.test",
    _basic_auth_header=lambda: "Basic x",
)


@pytest.fixture(autouse=True)
def _clear_cache():
    ebay_signature._key_cache.clear()
    yield
    ebay_signature._key_cache.clear()


def test_fetch_public_key_fetches_once_then_caches():
    fake = _FakeClient()
    with patch.object(ebay_signature.httpx, "AsyncClient", fake):
        first = asyncio.run(ebay_signature.fetch_public_key(SERVICE, TEST_KID))
        second = asyncio.run(ebay_signature.fetch_public_key(SERVICE, TEST_KID))
    assert first == second == {"key": PUBLIC_PEM, "digest": "SHA1"}
    assert fake.calls == [
        ("post", "https://api.ebay.test/token"),
        ("get", f"https://api.ebay.test/commerce/notification/v1/public_key/{TEST_KID}"),
    ]


def test_end_to_end_verify_request_with_fetched_key():
    body = b'{"ok": 1}'
    with patch.object(ebay_signature.httpx, "AsyncClient", _FakeClient()):
        asyncio.run(ebay_signature.verify_request(SERVICE, body, sign_header(body)))


@pytest.mark.parametrize("fake", [_FakeClient(token_status=401), _FakeClient(key_status=404)])
def test_fetch_public_key_upstream_errors(fake):
    with patch.object(ebay_signature.httpx, "AsyncClient", fake):
        with pytest.raises(ebay_signature.SignatureError):
            asyncio.run(ebay_signature.fetch_public_key(SERVICE, TEST_KID))


def test_fetch_public_key_rejects_path_injection_kid():
    with pytest.raises(ebay_signature.SignatureError, match="key id"):
        asyncio.run(ebay_signature.fetch_public_key(SERVICE, "../../oauth"))
