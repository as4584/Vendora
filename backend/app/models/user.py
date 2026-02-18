"""User model — Core Engine Layer."""
import uuid

from sqlalchemy import Column, String, Boolean, CheckConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.models.base import Base, TimestampMixin, SoftDeleteMixin


class User(Base, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "subscription_tier IN ('free', 'pro')",
            name="ck_users_subscription_tier",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    business_name = Column(String(255), nullable=True)
    subscription_tier = Column(String(20), nullable=False, server_default="free")
    is_partner = Column(Boolean, nullable=False, server_default="false")
    stripe_account_id = Column(String(255), nullable=True)
