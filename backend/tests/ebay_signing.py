"""Test helper: sign eBay notifications with a local key, as eBay would."""
import base64
import json
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

TEST_KID = "test-kid-1"
PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
# eBay serves the PEM on a single line; mimic that.
PUBLIC_PEM = "".join(
    PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
    .splitlines()
)


def sign_header(body: bytes, kid: str = TEST_KID, key=PRIVATE_KEY) -> str:
    signature = key.sign(body, ec.ECDSA(hashes.SHA1()))
    fields = {"alg": "ECDSA", "kid": kid, "signature": base64.b64encode(signature).decode(), "digest": "SHA1"}
    return base64.b64encode(json.dumps(fields).encode()).decode()


async def _fake_fetch(service, kid):
    return {"key": PUBLIC_PEM, "digest": "SHA1"}


def signed_ebay_post(client, payload, header: str | None = None):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    with patch("app.services.ebay_signature.fetch_public_key", _fake_fetch):
        return client.post(
            "/api/v1/integrations/ebay/deletion",
            content=body,
            headers={
                "Content-Type": "application/json",
                "x-ebay-signature": header if header is not None else sign_header(body),
            },
        )
