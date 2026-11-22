"""Time and money Resqlo saved a seller this month.

Counts work the integrations did instead of the seller (items and sales
imported, stock counts kept in step) and converts it to time with fixed,
stated per-entry estimates, plus the marketplace fees that were recorded so
profit isn't overstated. The estimates are shown to the user.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.provider import ProviderSyncRun
from app.models.transaction import Transaction

# Minutes a seller would otherwise spend per entry, typed by hand.
MINUTES_PER_ITEM = 3.0
MINUTES_PER_SALE = 2.0
MINUTES_PER_STOCK_UPDATE = 0.5


def month_start(now: datetime | None = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def get_savings(db: Session, user_id: uuid.UUID, since: datetime | None = None) -> dict:
    since = since or month_start()
    items, sales, updates = (
        db.query(
            func.coalesce(func.sum(ProviderSyncRun.items_imported), 0),
            func.coalesce(func.sum(ProviderSyncRun.transactions_imported), 0),
            func.coalesce(func.sum(ProviderSyncRun.items_updated), 0),
        )
        .filter(ProviderSyncRun.user_id == user_id, ProviderSyncRun.started_at >= since)
        .one()
    )
    fees = (
        db.query(func.coalesce(func.sum(Transaction.fee_amount), 0))
        .filter(
            Transaction.user_id == user_id,
            Transaction.created_at >= since,
            Transaction.is_refund.is_(False),
        )
        .scalar()
    )
    minutes = (
        int(items) * MINUTES_PER_ITEM
        + int(sales) * MINUTES_PER_SALE
        + int(updates) * MINUTES_PER_STOCK_UPDATE
    )
    return {
        "since": since,
        "minutes_saved": round(minutes),
        "items_imported": int(items),
        "sales_imported": int(sales),
        "stock_updates": int(updates),
        "fees_tracked": Decimal(fees or 0).quantize(Decimal("0.01")),
        "minutes_per_item": MINUTES_PER_ITEM,
        "minutes_per_sale": MINUTES_PER_SALE,
        "minutes_per_stock_update": MINUTES_PER_STOCK_UPDATE,
    }
