"""Base model with soft-delete mixin and declarative base."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime
from sqlalchemy.orm import DeclarativeBase, declared_attr


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    """Adds created_at and updated_at columns.
    updated_at is auto-set by PostgreSQL trigger (update_updated_at_column).
    """
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


class SoftDeleteMixin:
    """Adds deleted_at column for soft-delete.
    NULL = active record.
    TIMESTAMP = soft-deleted (recoverable within 30 days).
    """
    deleted_at = Column(DateTime(timezone=True), nullable=True, default=None)
