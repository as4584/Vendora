"""Encrypt provider tokens at rest + expand credential column widths.

Revision ID: 013
Revises: 012
Create Date: 2026-04-23

Changes:
  1. ALTER COLUMN — expand access_token / refresh_token widths on all three
     provider credential tables to accommodate Fernet ciphertext overhead
     (base64 of AES-128-CBC+HMAC-SHA256 adds ~80 bytes + ~1.35× plaintext size).

     lightspeed_tokens.access_token  : VARCHAR(2048) → VARCHAR(4096)
     lightspeed_tokens.refresh_token : VARCHAR(2048) → VARCHAR(4096)
     square_credentials.access_token : VARCHAR(512)  → VARCHAR(1024)
     clover_credentials.access_token : VARCHAR(512)  → VARCHAR(1024)

  2. Backfill — encrypt every existing plaintext row in-place.
     Rows already prefixed with "enc:" are skipped (idempotent re-run safety).

Rollback (downgrade):
  - Decrypts all "enc:" rows back to plaintext.
  - Shrinks columns back to original widths.

Rollout risk note:
  - The column ALTER runs first so the app can write longer encrypted values
    even while the backfill is in progress.
  - If the app is deployed before this migration runs, new writes are already
    encrypted (enc: prefix) while old rows remain plaintext.  The service layer
    decrypt_token() handles both transparently (backward-compat plaintext fallback).
  - If this migration is rolled back AFTER the new app is deployed, the downgrade
    script decrypts rows, but the app will continue trying to encrypt new writes
    until the old code is also re-deployed.  Coordinate code + migration rollbacks
    together.
"""
from alembic import op
import sqlalchemy as sa


revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Expand column widths ────────────────────────────────────────────────
    op.alter_column(
        "lightspeed_tokens", "access_token",
        existing_type=sa.String(2048),
        type_=sa.String(4096),
        existing_nullable=False,
    )
    op.alter_column(
        "lightspeed_tokens", "refresh_token",
        existing_type=sa.String(2048),
        type_=sa.String(4096),
        existing_nullable=False,
    )
    op.alter_column(
        "square_credentials", "access_token",
        existing_type=sa.String(512),
        type_=sa.String(1024),
        existing_nullable=False,
    )
    op.alter_column(
        "clover_credentials", "access_token",
        existing_type=sa.String(512),
        type_=sa.String(1024),
        existing_nullable=False,
    )

    # ── 2. Backfill-encrypt existing plaintext rows ────────────────────────────
    # Import here so the migration is self-contained and only loads crypto code
    # when actually executing — not at import time of all migrations.
    from app.security.token_encryption import encrypt_token, ENC_PREFIX  # noqa: PLC0415

    conn = op.get_bind()

    # lightspeed_tokens (two token columns)
    rows = conn.execute(
        sa.text(
            "SELECT id, access_token, refresh_token FROM lightspeed_tokens "
            "WHERE access_token NOT LIKE :prefix"
        ),
        {"prefix": f"{ENC_PREFIX}%"},
    ).fetchall()
    for row in rows:
        conn.execute(
            sa.text(
                "UPDATE lightspeed_tokens "
                "SET access_token = :at, refresh_token = :rt "
                "WHERE id = :id"
            ),
            {
                "at": encrypt_token(row.access_token),
                "rt": encrypt_token(row.refresh_token),
                "id": str(row.id),
            },
        )

    # square_credentials
    rows = conn.execute(
        sa.text(
            "SELECT id, access_token FROM square_credentials "
            "WHERE access_token NOT LIKE :prefix"
        ),
        {"prefix": f"{ENC_PREFIX}%"},
    ).fetchall()
    for row in rows:
        conn.execute(
            sa.text(
                "UPDATE square_credentials SET access_token = :at WHERE id = :id"
            ),
            {"at": encrypt_token(row.access_token), "id": str(row.id)},
        )

    # clover_credentials
    rows = conn.execute(
        sa.text(
            "SELECT id, access_token FROM clover_credentials "
            "WHERE access_token NOT LIKE :prefix"
        ),
        {"prefix": f"{ENC_PREFIX}%"},
    ).fetchall()
    for row in rows:
        conn.execute(
            sa.text(
                "UPDATE clover_credentials SET access_token = :at WHERE id = :id"
            ),
            {"at": encrypt_token(row.access_token), "id": str(row.id)},
        )


def downgrade() -> None:
    from app.security.token_encryption import decrypt_token, ENC_PREFIX  # noqa: PLC0415

    conn = op.get_bind()

    # Decrypt lightspeed_tokens
    rows = conn.execute(
        sa.text(
            "SELECT id, access_token, refresh_token FROM lightspeed_tokens "
            "WHERE access_token LIKE :prefix"
        ),
        {"prefix": f"{ENC_PREFIX}%"},
    ).fetchall()
    for row in rows:
        conn.execute(
            sa.text(
                "UPDATE lightspeed_tokens "
                "SET access_token = :at, refresh_token = :rt "
                "WHERE id = :id"
            ),
            {
                "at": decrypt_token(row.access_token),
                "rt": decrypt_token(row.refresh_token),
                "id": str(row.id),
            },
        )

    # Decrypt square_credentials
    rows = conn.execute(
        sa.text(
            "SELECT id, access_token FROM square_credentials "
            "WHERE access_token LIKE :prefix"
        ),
        {"prefix": f"{ENC_PREFIX}%"},
    ).fetchall()
    for row in rows:
        conn.execute(
            sa.text("UPDATE square_credentials SET access_token = :at WHERE id = :id"),
            {"at": decrypt_token(row.access_token), "id": str(row.id)},
        )

    # Decrypt clover_credentials
    rows = conn.execute(
        sa.text(
            "SELECT id, access_token FROM clover_credentials "
            "WHERE access_token LIKE :prefix"
        ),
        {"prefix": f"{ENC_PREFIX}%"},
    ).fetchall()
    for row in rows:
        conn.execute(
            sa.text("UPDATE clover_credentials SET access_token = :at WHERE id = :id"),
            {"at": decrypt_token(row.access_token), "id": str(row.id)},
        )

    # Shrink columns back to original widths
    op.alter_column(
        "lightspeed_tokens", "access_token",
        existing_type=sa.String(4096),
        type_=sa.String(2048),
        existing_nullable=False,
    )
    op.alter_column(
        "lightspeed_tokens", "refresh_token",
        existing_type=sa.String(4096),
        type_=sa.String(2048),
        existing_nullable=False,
    )
    op.alter_column(
        "square_credentials", "access_token",
        existing_type=sa.String(1024),
        type_=sa.String(512),
        existing_nullable=False,
    )
    op.alter_column(
        "clover_credentials", "access_token",
        existing_type=sa.String(1024),
        type_=sa.String(512),
        existing_nullable=False,
    )
