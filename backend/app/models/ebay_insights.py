"""eBay insights: per-order fees (Finances API), payouts, listing traffic cache."""
import uuid

import sqlalchemy as sa
from sqlalchemy import Column, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Uuid

from app.models.base import Base, TimestampMixin


class EbayOrderFees(Base, TimestampMixin):
    """eBay fees for one imported order, from Sell Finances getTransactions.

    The matching Transaction (source "ebay", external_reference_id = order id)
    carries fee_amount = total_fees and net_amount = gross - total_fees, so
    profit matches what eBay actually pays out. ``lines`` keeps the per order
    line breakdown as returned by eBay (fee type -> amount strings).
    """

    __tablename__ = "ebay_order_fees"
    __table_args__ = (
        Index("uq_ebay_order_fees_user_order", "user_id", "order_id", unique=True),
        Index("ix_ebay_order_fees_payout", "user_id", "payout_id"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    transaction_id = Column(Uuid, ForeignKey("transactions.id", ondelete="SET NULL"), nullable=True)
    order_id = Column(String(100), nullable=False)
    final_value_fee = Column(Numeric(10, 2), nullable=False, server_default="0.00", default=0)
    ad_fee = Column(Numeric(10, 2), nullable=False, server_default="0.00", default=0)
    shipping_label = Column(Numeric(10, 2), nullable=False, server_default="0.00", default=0)
    other_fees = Column(Numeric(10, 2), nullable=False, server_default="0.00", default=0)
    total_fees = Column(Numeric(10, 2), nullable=False, server_default="0.00", default=0)
    # What eBay credited for the sale (SALE transaction amount), before labels/ads.
    sale_net = Column(Numeric(10, 2), nullable=True)
    payout_id = Column(String(100), nullable=True)
    lines = Column(sa.JSON, nullable=True)


class EbayPayout(Base, TimestampMixin):
    """One eBay payout plus how well imported orders reconcile against it."""

    __tablename__ = "ebay_payouts"
    __table_args__ = (Index("uq_ebay_payouts_user_payout", "user_id", "payout_id", unique=True),)

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    payout_id = Column(String(100), nullable=False)
    amount = Column(Numeric(12, 2), nullable=False)
    currency = Column(String(3), nullable=False, server_default="USD", default="USD")
    status = Column(String(30), nullable=True)
    payout_date = Column(DateTime(timezone=True), nullable=True)
    transaction_count = Column(Integer, nullable=True)
    # Sum of eBay-side net for the transactions eBay put in this payout.
    ebay_net = Column(Numeric(12, 2), nullable=True)
    # Sum of Resqlo net for imported orders in this payout.
    resqlo_net = Column(Numeric(12, 2), nullable=True)
    orders_matched = Column(Integer, nullable=False, server_default="0", default=0)
    orders_missing = Column(Integer, nullable=False, server_default="0", default=0)


class EbayListingTraffic(Base, TimestampMixin):
    """Daily cache of Sell Analytics traffic + watch count for one listing."""

    __tablename__ = "ebay_listing_traffic"
    __table_args__ = (
        Index("uq_ebay_traffic_listing_day", "user_id", "listing_id", "day", unique=True),
        Index("ix_ebay_traffic_item", "inventory_item_id"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    inventory_item_id = Column(Uuid, ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False)
    listing_id = Column(String(64), nullable=False)
    day = Column(Date, nullable=False)
    views = Column(Integer, nullable=True)
    impressions = Column(Integer, nullable=True)
    click_through_rate = Column(Numeric(7, 4), nullable=True)
    conversion_rate = Column(Numeric(7, 4), nullable=True)
    sales = Column(Integer, nullable=True)
    watchers = Column(Integer, nullable=True)
