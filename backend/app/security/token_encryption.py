"""Token encryption utilities for provider credentials stored at rest.

Algorithm: Fernet symmetric encryption (AES-128-CBC + HMAC-SHA256).
Key source:
  1. PROVIDER_TOKEN_KEY env var — a valid URL-safe base64-encoded 32-byte key.
     Generate with: python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  2. Fallback: SHA-256 of SECRET_KEY, base64url-encoded.  This is acceptable
     for development and small deploys; rotate to a dedicated key in production.

Storage format:
  Encrypted tokens are stored as "enc:<fernet-ciphertext>" in the database.
  Tokens lacking the "enc:" prefix are treated as legacy plaintext and
  returned unchanged (backward-compatibility window).

Typical ciphertext overhead: ~80 bytes + ~1.35× the plaintext size (base64).
Column widths have been expanded in migration 013 to accommodate this.
"""
from __future__ import annotations

import base64
import hashlib
import logging
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

ENC_PREFIX = "enc:"


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    """Build (and cache) a Fernet instance from configured key material."""
    # Lazy import to avoid circular dependency at module load time
    from app.config import settings  # noqa: PLC0415

    if settings.PROVIDER_TOKEN_KEY:
        key = settings.PROVIDER_TOKEN_KEY.encode()
    else:
        # Derive a 32-byte key from SECRET_KEY via SHA-256
        raw = hashlib.sha256(settings.SECRET_KEY.encode()).digest()
        key = base64.urlsafe_b64encode(raw)
    return Fernet(key)


def encrypt_token(plaintext: str) -> str:
    """Encrypt *plaintext* and return an "enc:<ciphertext>" string for DB storage."""
    ciphertext = _fernet().encrypt(plaintext.encode()).decode()
    return ENC_PREFIX + ciphertext


def decrypt_token(stored: str) -> str:
    """Decrypt a stored token.

    * If the value begins with "enc:", strip the prefix and decrypt.
    * Otherwise return it unchanged (legacy plaintext row — backward compat).
    """
    if not stored.startswith(ENC_PREFIX):
        logger.warning(
            "Decrypting token without 'enc:' prefix — treating as legacy plaintext. "
            "Run migration 013 to encrypt all existing rows."
        )
        return stored
    try:
        return _fernet().decrypt(stored[len(ENC_PREFIX):].encode()).decode()
    except InvalidToken as exc:
        raise ValueError(
            "Provider token decryption failed — check PROVIDER_TOKEN_KEY matches "
            "the key used when the token was encrypted."
        ) from exc
