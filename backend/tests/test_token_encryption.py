"""Token encryption tests.

Coverage:
  TestEncryptDecrypt (unit — no DB)
    - round-trip encrypt → decrypt returns original plaintext
    - different plaintext values produce different ciphertexts
    - ciphertext is prefixed with "enc:"
    - decrypt of legacy plaintext (no prefix) returns value unchanged
    - decrypt of tampered ciphertext raises ValueError

  TestSquareEncryption (service layer)
    - store_credential writes an encrypted value (enc: prefix) to DB
    - the stored ciphertext decrypts back to the original access_token
    - updating credential via store_credential re-encrypts new value
    - _do_sync calls _fetch_catalog with plaintext token (decrypt on read)

  TestCloverEncryption (service layer)
    - store_credential writes an encrypted value (enc: prefix) to DB
    - the stored ciphertext decrypts back to the original access_token
    - _do_sync calls _fetch_items with plaintext token (decrypt on read)

  TestLightspeedEncryption (service layer)
    - upsert_token writes encrypted access_token and refresh_token
    - stored values decrypt correctly
    - _do_sync calls _get_all_pages with plaintext token (decrypt on read)

  TestBackwardCompatibility
    - plaintext rows (pre-migration) are returned as-is by decrypt_token
    - Square _do_sync succeeds with a plaintext access_token in the DB
    - Clover _do_sync succeeds with a plaintext access_token in the DB
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.models.clover import CloverCredential
from app.models.integration import LightspeedToken
from app.models.square import SquareCredential
from app.security.token_encryption import ENC_PREFIX, decrypt_token, encrypt_token
from app.services.clover import clover_service
from app.services.square import square_service


# ─── TestEncryptDecrypt ────────────────────────────────────────────────────────

class TestEncryptDecrypt:
    def test_round_trip(self):
        original = "my-secret-access-token-abc123"
        assert decrypt_token(encrypt_token(original)) == original

    def test_ciphertext_has_enc_prefix(self):
        encrypted = encrypt_token("tok")
        assert encrypted.startswith(ENC_PREFIX)

    def test_different_plaintexts_produce_different_ciphertexts(self):
        a = encrypt_token("token_a")
        b = encrypt_token("token_b")
        assert a != b

    def test_same_plaintext_produces_different_ciphertexts_each_call(self):
        # Fernet uses a random IV — two encryptions of the same value differ
        a = encrypt_token("same")
        b = encrypt_token("same")
        assert a != b
        # But both decrypt to the same original
        assert decrypt_token(a) == decrypt_token(b) == "same"

    def test_legacy_plaintext_passthrough(self):
        """decrypt_token must return plaintext unchanged when no enc: prefix."""
        plaintext_token = "legacy_plain_tok_no_prefix"
        assert decrypt_token(plaintext_token) == plaintext_token

    def test_tampered_ciphertext_raises_value_error(self):
        encrypted = encrypt_token("real-token")
        tampered = ENC_PREFIX + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        with pytest.raises(ValueError, match="decryption failed"):
            decrypt_token(tampered)

    def test_empty_string_round_trip(self):
        # Edge case: empty string is a valid plaintext
        assert decrypt_token(encrypt_token("")) == ""


# ─── TestSquareEncryption ──────────────────────────────────────────────────────

class TestSquareEncryption:
    def test_store_credential_writes_encrypted_value(self, db, test_user):
        square_service.store_credential(
            db,
            user_id=test_user.id,
            access_token="sq_plaintext_token",
        )

        raw = (
            db.query(SquareCredential.access_token)
            .filter(SquareCredential.user_id == test_user.id)
            .scalar()
        )
        assert raw.startswith(ENC_PREFIX), f"Expected enc: prefix, got: {raw[:30]}"

    def test_stored_ciphertext_decrypts_to_original(self, db, test_user):
        original = "sq_live_ABCDEF123456"
        square_service.store_credential(
            db, user_id=test_user.id, access_token=original
        )

        raw = (
            db.query(SquareCredential.access_token)
            .filter(SquareCredential.user_id == test_user.id)
            .scalar()
        )
        assert decrypt_token(raw) == original

    def test_update_credential_re_encrypts(self, db, test_user):
        square_service.store_credential(
            db, user_id=test_user.id, access_token="old_token"
        )
        square_service.store_credential(
            db, user_id=test_user.id, access_token="new_token"
        )

        raw = (
            db.query(SquareCredential.access_token)
            .filter(SquareCredential.user_id == test_user.id)
            .scalar()
        )
        assert raw.startswith(ENC_PREFIX)
        assert decrypt_token(raw) == "new_token"

    @pytest.mark.asyncio
    async def test_do_sync_decrypts_before_http_call(self, db, test_user):
        """_fetch_catalog must receive the plaintext token, not the enc: blob."""
        original = "sq_plaintext_123"
        square_service.store_credential(
            db, user_id=test_user.id, access_token=original
        )
        db.commit()

        received_tokens: list[str] = []

        async def capture_catalog(access_token: str) -> list:
            received_tokens.append(access_token)
            return []

        with (
            patch.object(square_service, "_fetch_catalog", new=capture_catalog),
            patch.object(
                square_service,
                "_fetch_inventory_counts",
                new=AsyncMock(return_value={}),
            ),
        ):
            await square_service.sync(db, test_user.id)

        assert len(received_tokens) == 1
        assert received_tokens[0] == original
        assert not received_tokens[0].startswith(ENC_PREFIX)


# ─── TestCloverEncryption ──────────────────────────────────────────────────────

class TestCloverEncryption:
    def test_store_credential_writes_encrypted_value(self, db, test_user):
        clover_service.store_credential(
            db,
            user_id=test_user.id,
            merchant_id="MERCH_CLV",
            access_token="clv_plaintext_token",
        )

        raw = (
            db.query(CloverCredential.access_token)
            .filter(CloverCredential.user_id == test_user.id)
            .scalar()
        )
        assert raw.startswith(ENC_PREFIX)

    def test_stored_ciphertext_decrypts_to_original(self, db, test_user):
        original = "clv_live_SECRET_999"
        clover_service.store_credential(
            db,
            user_id=test_user.id,
            merchant_id="MID",
            access_token=original,
        )

        raw = (
            db.query(CloverCredential.access_token)
            .filter(CloverCredential.user_id == test_user.id)
            .scalar()
        )
        assert decrypt_token(raw) == original

    @pytest.mark.asyncio
    async def test_do_sync_decrypts_before_http_call(self, db, test_user):
        """_fetch_items must receive the plaintext token."""
        original = "clv_plaintext_abc"
        clover_service.store_credential(
            db,
            user_id=test_user.id,
            merchant_id="MID_X",
            access_token=original,
        )
        db.commit()

        received: list[tuple[str, str]] = []

        async def capture_items(access_token: str, merchant_id: str) -> list:
            received.append((access_token, merchant_id))
            return []

        with patch.object(clover_service, "_fetch_items", new=capture_items):
            await clover_service.sync(db, test_user.id)

        assert len(received) == 1
        assert received[0][0] == original
        assert not received[0][0].startswith(ENC_PREFIX)


# ─── TestLightspeedEncryption ─────────────────────────────────────────────────

class TestLightspeedEncryption:
    def _make_token(self, db, user_id):
        from app.services.lightspeed import lightspeed_service

        return lightspeed_service.upsert_token(
            db,
            user_id=user_id,
            account_id="ACCT_123",
            access_token="ls_access_plaintext",
            refresh_token="ls_refresh_plaintext",
            expires_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
        )

    def test_upsert_token_encrypts_both_tokens(self, db, test_user):
        self._make_token(db, test_user.id)

        raw_at, raw_rt = (
            db.query(LightspeedToken.access_token, LightspeedToken.refresh_token)
            .filter(LightspeedToken.user_id == test_user.id)
            .one()
        )
        assert raw_at.startswith(ENC_PREFIX)
        assert raw_rt.startswith(ENC_PREFIX)

    def test_stored_tokens_decrypt_to_originals(self, db, test_user):
        self._make_token(db, test_user.id)

        raw_at, raw_rt = (
            db.query(LightspeedToken.access_token, LightspeedToken.refresh_token)
            .filter(LightspeedToken.user_id == test_user.id)
            .one()
        )
        assert decrypt_token(raw_at) == "ls_access_plaintext"
        assert decrypt_token(raw_rt) == "ls_refresh_plaintext"

    @pytest.mark.asyncio
    async def test_do_sync_decrypts_before_http_call(self, db, test_user):
        """_get_all_pages must receive the plaintext access token."""
        from app.services.lightspeed import lightspeed_service

        self._make_token(db, test_user.id)
        db.commit()

        received_tokens: list[str] = []

        async def capture_pages(access_token: str, url: str, root_key: str) -> list:
            received_tokens.append(access_token)
            return []

        with patch.object(lightspeed_service, "_get_all_pages", new=capture_pages):
            await lightspeed_service.sync(db, test_user.id)

        assert len(received_tokens) >= 1
        assert received_tokens[0] == "ls_access_plaintext"
        assert not received_tokens[0].startswith(ENC_PREFIX)


# ─── TestBackwardCompatibility ────────────────────────────────────────────────

class TestBackwardCompatibility:
    """Verify that legacy plaintext rows (pre-migration) still work correctly."""

    def test_decrypt_plaintext_passthrough(self):
        plain = "raw_token_no_enc_prefix"
        assert decrypt_token(plain) == plain

    @pytest.mark.asyncio
    async def test_square_sync_works_with_legacy_plaintext_row(self, db, test_user):
        """Simulate a pre-migration plaintext credential row."""
        # Insert credential directly (bypass store_credential's encrypt call)
        legacy_token = "sq_legacy_plaintext"
        db.add(
            SquareCredential(
                user_id=test_user.id,
                access_token=legacy_token,  # plaintext — no enc: prefix
            )
        )
        db.flush()

        received: list[str] = []

        async def capture_catalog(access_token: str) -> list:
            received.append(access_token)
            return []

        with (
            patch.object(square_service, "_fetch_catalog", new=capture_catalog),
            patch.object(
                square_service,
                "_fetch_inventory_counts",
                new=AsyncMock(return_value={}),
            ),
        ):
            await square_service.sync(db, test_user.id)

        # decrypt_token falls back to returning plaintext unchanged
        assert received[0] == legacy_token

    @pytest.mark.asyncio
    async def test_clover_sync_works_with_legacy_plaintext_row(self, db, test_user):
        """Simulate a pre-migration plaintext credential row."""
        legacy_token = "clv_legacy_plaintext"
        db.add(
            CloverCredential(
                user_id=test_user.id,
                merchant_id="MID_LEGACY",
                access_token=legacy_token,
            )
        )
        db.flush()

        received: list[tuple] = []

        async def capture_items(access_token: str, merchant_id: str) -> list:
            received.append((access_token, merchant_id))
            return []

        with patch.object(clover_service, "_fetch_items", new=capture_items):
            await clover_service.sync(db, test_user.id)

        assert received[0][0] == legacy_token
