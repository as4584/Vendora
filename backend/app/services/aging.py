"""Items that aren't selling: find stock sitting unsold and nudge the seller.

``aging_items`` lists in-stock/listed items older than N days. ``run_aging_alerts``
(called from the background sweep, at most once a day per process) pushes a
weekly reminder to Pro sellers who have aging stock, recorded as an AppEvent
so it isn't repeated.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.app_event import AppEvent
from app.models.inventory import InventoryItem
from app.models.user import User

logger = logging.getLogger(__name__)

AGING_DAYS = 60
ALERT_EVENT = "aging_alert_sent"
ALERT_EVERY = timedelta(days=7)
_last_run: date | None = None


def _aging_query(db: Session, user_id: uuid.UUID | None, days: int, now: datetime):
    q = db.query(InventoryItem).filter(
        InventoryItem.deleted_at.is_(None),
        InventoryItem.status.in_(["in_stock", "listed"]),
        InventoryItem.quantity > 0,
        InventoryItem.created_at <= now - timedelta(days=days),
    )
    return q if user_id is None else q.filter(InventoryItem.user_id == user_id)


def aging_items(db: Session, user_id: uuid.UUID, days: int = AGING_DAYS, limit: int = 100,
                now: datetime | None = None) -> tuple[int, list[InventoryItem]]:
    now = now or datetime.now(timezone.utc)
    q = _aging_query(db, user_id, days, now)
    return q.count(), q.order_by(InventoryItem.created_at.asc()).limit(limit).all()


def alert_message(count: int, days: int = AGING_DAYS) -> tuple[str, str]:
    noun = "item has" if count == 1 else "items have"
    return (
        f"{count} {noun} sat {days}+ days",
        "A small price drop often gets old stock moving. Tap to review.",
    )


async def run_aging_alerts(db: Session, now: datetime | None = None) -> int:
    """Push the weekly aging reminder to Pro sellers who are due. Returns pushes sent."""
    from app.services.push import send_push

    now = now or datetime.now(timezone.utc)
    rows = (
        _aging_query(db, None, AGING_DAYS, now)
        .join(User, User.id == InventoryItem.user_id)
        .filter(User.subscription_tier == "pro")
        .with_entities(InventoryItem.user_id, func.count(InventoryItem.id))
        .group_by(InventoryItem.user_id)
        .all()
    )
    sent = 0
    for user_id, count in rows:
        recent = (
            db.query(AppEvent.id)
            .filter(AppEvent.user_id == user_id, AppEvent.name == ALERT_EVENT,
                    AppEvent.created_at >= now - ALERT_EVERY)
            .first()
        )
        if recent:
            continue
        title, body = alert_message(int(count))
        try:
            await send_push(db, user_id, title, body, {"url": "/inventory/aging"})
        except Exception:  # noqa: BLE001 - one user's failure never stops the rest
            logger.warning("aging alert push failed for %s", user_id, exc_info=True)
            continue
        db.add(AppEvent(user_id=user_id, name=ALERT_EVENT, props={"count": int(count)}))
        db.commit()
        sent += 1
    return sent


async def run_daily(db: Session) -> int:
    """Called every sweep; does the work at most once per UTC day."""
    global _last_run
    today = datetime.now(timezone.utc).date()
    if _last_run == today:
        return 0
    _last_run = today
    return await run_aging_alerts(db)
