"""Verify the x-ebay-signature header on eBay marketplace notifications.

The header is base64-encoded JSON {alg, kid, signature, digest}. The public
key for ``kid`` comes from eBay's Notification API and is cached; the
signature is ECDSA over the raw request body.
"""
import base64
import json
import logging
import re
import time

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

logger = logging.getLogger(__name__)

_KEY_TTL_SECONDS = 3600
_key_cache: dict[str, tuple[float, str]] = {}
_DIGESTS = {"SHA1": hashes.SHA1, "SHA256": hashes.SHA256}


class SignatureError(Exception):
    pass


class KeyUnavailableError(SignatureError):
    """eBay's public key could not be obtained, so the signature can't be checked.

    Happens when a notice comes from the other eBay environment (e.g. a
    Production test notice while this server holds Sandbox keys), or when the
    keyset is not yet enabled. Distinct from a signature that is checked and wrong.
    """


def parse_header(header: str) -> dict:
    try:
        parsed = json.loads(base64.b64decode(header, validate=True))
    except Exception as exc:
        raise SignatureError("Malformed signature header") from exc
    if not isinstance(parsed, dict) or not parsed.get("kid") or not parsed.get("signature"):
        raise SignatureError("Signature header missing kid or signature")
    return parsed


def _load_pem(key: str):
    """eBay returns the PEM without line breaks; rebuild it before loading."""
    body = re.sub(r"-----(BEGIN|END) PUBLIC KEY-----|\s", "", key)
    lines = "\n".join(body[i:i + 64] for i in range(0, len(body), 64))
    pem = f"-----BEGIN PUBLIC KEY-----\n{lines}\n-----END PUBLIC KEY-----\n"
    return serialization.load_pem_public_key(pem.encode())


def verify(body: bytes, header_fields: dict, public_key_pem: str, digest: str = "SHA1") -> None:
    hash_cls = _DIGESTS.get((digest or "SHA1").upper())
    if hash_cls is None:
        raise SignatureError("Unsupported digest")
    try:
        key = _load_pem(public_key_pem)
        if not isinstance(key, ec.EllipticCurvePublicKey):
            raise SignatureError("Unexpected key type")
        key.verify(base64.b64decode(header_fields["signature"]), body, ec.ECDSA(hash_cls()))
    except SignatureError:
        raise
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise SignatureError("Signature does not match") from exc


async def fetch_public_key(service, kid: str) -> dict:
    """Return eBay's {key, digest} for ``kid``, cached for an hour."""
    cached = _key_cache.get(kid)
    if cached and time.monotonic() - cached[0] < _KEY_TTL_SECONDS:
        return json.loads(cached[1])
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", kid):
        raise SignatureError("Invalid key id")
    async with httpx.AsyncClient(timeout=15) as client:
        token_resp = await client.post(
            service.token_url,
            headers={
                "Authorization": service._basic_auth_header(),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "client_credentials", "scope": "https://api.ebay.com/oauth/api_scope"},
        )
        if token_resp.status_code >= 400:
            raise KeyUnavailableError("Could not obtain eBay application token")
        app_token = token_resp.json().get("access_token")
        key_resp = await client.get(
            f"{service.api_base}/commerce/notification/v1/public_key/{kid}",
            headers={"Authorization": f"Bearer {app_token}"},
        )
    if key_resp.status_code >= 400:
        raise KeyUnavailableError("Could not fetch eBay public key")
    data = key_resp.json()
    result = {"key": data.get("key", ""), "digest": data.get("digest") or "SHA1"}
    _key_cache[kid] = (time.monotonic(), json.dumps(result))
    return result


async def verify_request(service, body: bytes, header: str | None) -> None:
    if not header:
        raise SignatureError("Missing signature header")
    fields = parse_header(header)
    key = await fetch_public_key(service, fields["kid"])
    verify(body, fields, key["key"], key["digest"])
