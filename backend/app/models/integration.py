"""Integration models (Lightspeed, etc.)."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Index, String, Uuid

from app.models.base import Base, TimestampMixin


class LightspeedToken(Base, TimestampMixin):
    __tablename__ = "lightspeed_tokens"
    __table_args__ = (
        Index("ix_lightspeed_tokens_user_id", "user_id", unique=True),
        Index("ix_lightspeed_tokens_account_id", "account_id"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True)
    account_id = Column(String(255), nullable=False)
    # Encrypted at rest via app.security.token_encryption (enc: prefix).  Column
    # widths are expanded to accommodate Fernet ciphertext overhead (~1.35× + 80 b).
    access_token = Column(String(4096), nullable=False)
    refresh_token = Column(String(4096), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    scopes = Column(String(512), nullable=True)

    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) >= self.expires_at


class EbayToken(Base, TimestampMixin):
    """OAuth credentials for a user's connected eBay seller account.

    eBay does not return a stable numeric account id from the token exchange, so
    ``account_id`` holds the eBay username (best-effort, via the Identity API) or
    None. eBay API calls use a fixed base URL, so account_id is display-only.
    """

    __tablename__ = "ebay_tokens"
    __table_args__ = (
        Index("ix_ebay_tokens_user_id", "user_id", unique=True),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True)
    account_id = Column(String(255), nullable=True)
    # Encrypted at rest via app.security.token_encryption (enc: prefix).
    access_token = Column(String(4096), nullable=False)
    refresh_token = Column(String(4096), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    scopes = Column(String(1024), nullable=True)

    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) >= self.expires_at
