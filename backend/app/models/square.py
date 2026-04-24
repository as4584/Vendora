"""Square integration model — stores per-user API credentials."""
import uuid

from sqlalchemy import Column, ForeignKey, String, Uuid

from app.models.base import Base, TimestampMixin


class SquareCredential(Base, TimestampMixin):
    """Stores a Square access token and optional location configuration.

    Square supports personal access tokens and OAuth tokens interchangeably
    for API v2.  The merchant_id is resolved on first sync if not supplied.
    location_id, if set, restricts inventory counts to that Square location;
    otherwise inventory is summed across all active locations.

    Security note: access_token is stored plaintext (same as LightspeedToken).
    Encryption at rest is a follow-up hardening item.
    """

    __tablename__ = "square_credentials"

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(
        Uuid,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    # Square API v2 access token (personal or OAuth). Encrypted at rest.
    access_token = Column(String(1024), nullable=False)
    # Square merchant ID (resolved automatically on first sync)
    merchant_id = Column(String(255), nullable=True)
    # Optional: restrict inventory counts to a single Square location
    location_id = Column(String(255), nullable=True)
