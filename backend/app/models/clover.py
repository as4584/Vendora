"""Clover integration model — stores per-user API credentials."""
import uuid

from sqlalchemy import Column, ForeignKey, String, Uuid

from app.models.base import Base, TimestampMixin


class CloverCredential(Base, TimestampMixin):
    """Stores a Clover access token and merchant configuration.

    Clover requires a merchant_id (mid) for every API call, so it is
    required at connect time rather than being resolved lazily like Square.
    The access_token may be a developer/personal token or an OAuth token —
    both work identically against the Clover REST API v3.

    Security note: access_token is stored plaintext (same as SquareCredential
    and LightspeedToken).  Encryption at rest is a follow-up hardening item.
    """

    __tablename__ = "clover_credentials"

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(
        Uuid,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    # Clover merchant ID — required; used in every API request path
    merchant_id = Column(String(255), nullable=False)
    # Clover API access token (developer or OAuth). Encrypted at rest.
    access_token = Column(String(1024), nullable=False)
