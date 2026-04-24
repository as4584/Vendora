"""Integration models (Lightspeed, etc.)."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, String, Uuid

from app.models.base import Base, TimestampMixin


class LightspeedToken(Base, TimestampMixin):
    __tablename__ = "lightspeed_tokens"

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
