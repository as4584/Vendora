"""Google Sheets sync models.

  GoogleToken      — encrypted OAuth credentials (one per user; drive.file + openid email).
  GoogleSheetLink  — the one spreadsheet a user keeps in sync with inventory.

``row_state`` holds, per item id, the field values as of the last successful
sync. Pull compares the sheet and the app against it to tell who changed what
("sheet wins" when both did); push refuses to overwrite a row the seller
edited in the sheet since then.
"""
import uuid

import sqlalchemy as sa
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, String, Uuid

from app.models.base import Base, TimestampMixin


class GoogleToken(Base, TimestampMixin):
    __tablename__ = "google_tokens"
    __table_args__ = (Index("ix_google_tokens_user_id", "user_id", unique=True),)

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    email = Column(String(255), nullable=True)
    # Encrypted at rest via app.security.token_encryption (enc: prefix).
    access_token = Column(String(8192), nullable=False)
    refresh_token = Column(String(4096), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    scopes = Column(String(1024), nullable=True)


class GoogleSheetLink(Base, TimestampMixin):
    __tablename__ = "google_sheet_links"
    __table_args__ = (Index("ix_google_sheet_links_user_id", "user_id", unique=True),)

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    spreadsheet_id = Column(String(255), nullable=False)
    spreadsheet_title = Column(String(255), nullable=True)
    spreadsheet_url = Column(String(1024), nullable=True)
    sheet_tab = Column(String(255), nullable=False)
    sheet_gid = Column(sa.Integer, nullable=True)
    # canonical field -> 0-based column index in the tab
    header_map = Column(sa.JSON, nullable=False, default=dict)
    # item id -> {field: value} at last sync
    row_state = Column(sa.JSON, nullable=False, default=dict)
    last_values_hash = Column(String(64), nullable=True)
    last_synced_at = Column(DateTime(timezone=True), nullable=True)
    last_error = Column(sa.Text, nullable=True)
    source_of_truth = Column(Boolean, nullable=False, default=True, server_default=sa.true())
    # Archive items whose row was deleted from the sheet (else: flag for review).
    archive_missing = Column(Boolean, nullable=False, default=False, server_default=sa.false())
