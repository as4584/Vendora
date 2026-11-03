"""StockX integration models.

  StockxToken        — encrypted OAuth credentials (one per user), mirrors EbayToken.
  StockxListing      — an ask placed on StockX for one matched item/size (variant).
  StockxMarketCache  — short-TTL cache of per-variant market data (shared by all users;
                       market data is not seller-specific) so we don't hit rate limits.
"""
import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Index, Numeric, String, Uuid

from app.models.base import Base, TimestampMixin

LISTING_STATUSES = ("pending", "active", "inactive", "deleted", "sold", "failed")


class StockxToken(Base, TimestampMixin):
    __tablename__ = "stockx_tokens"
    __table_args__ = (Index("ix_stockx_tokens_user_id", "user_id", unique=True),)

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    account_id = Column(String(255), nullable=True)
    # Encrypted at rest via app.security.token_encryption (enc: prefix).
    access_token = Column(String(8192), nullable=False)
    refresh_token = Column(String(4096), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    scopes = Column(String(1024), nullable=True)

    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) >= self.expires_at


class StockxListing(Base, TimestampMixin):
    __tablename__ = "stockx_listings"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','active','inactive','deleted','sold','failed')",
            name="ck_stockx_listings_status",
        ),
        Index("ix_stockx_listings_user_id", "user_id"),
        Index("ix_stockx_listings_item_id", "inventory_item_id"),
        Index(
            "uq_stockx_listings_listing_id",
            "listing_id",
            unique=True,
            postgresql_where=sa.text("listing_id IS NOT NULL"),
        ),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    inventory_item_id = Column(
        Uuid, ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False
    )
    product_id = Column(String(100), nullable=False)
    variant_id = Column(String(100), nullable=False)
    size = Column(String(50), nullable=True)
    listing_id = Column(String(100), nullable=True)
    amount = Column(Numeric(10, 2), nullable=False)
    currency_code = Column(String(3), nullable=False, server_default="USD")
    status = Column(String(20), nullable=False, server_default="pending")
    last_error = Column(sa.Text, nullable=True)


class StockxMarketCache(Base):
    __tablename__ = "stockx_market_cache"
    __table_args__ = (
        Index("uq_stockx_market_cache_variant", "variant_id", "currency_code", unique=True),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    product_id = Column(String(100), nullable=False)
    variant_id = Column(String(100), nullable=False)
    currency_code = Column(String(3), nullable=False, server_default="USD")
    lowest_ask = Column(Numeric(10, 2), nullable=True)
    highest_bid = Column(Numeric(10, 2), nullable=True)
    last_sale = Column(Numeric(10, 2), nullable=True)
    raw = Column(sa.JSON, nullable=True)
    fetched_at = Column(DateTime(timezone=True), nullable=False)
