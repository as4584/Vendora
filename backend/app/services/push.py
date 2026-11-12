"""Expo push delivery. Best-effort: never raises into sync or webhook handling."""

import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models.push_token import PushToken

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
# Orders older than this are history (first sync, backfill), not news.
SALE_ALERT_MAX_AGE = timedelta(hours=6)
# More recent sales than this in one sync collapse into a single summary alert.
SALE_ALERT_BATCH_LIMIT = 3


def is_expo_token(token: str) -> bool:
    return token.startswith(
        ("ExponentPushToken[", "ExpoPushToken[")
    ) and token.endswith("]")


async def send_push(
    db: Session,
    user_id: uuid.UUID,
    title: str,
    body: str,
    data: Optional[dict[str, Any]] = None,
) -> int:
    """Send to every device of the user. Returns messages accepted by Expo."""
    if not settings.PUSH_ENABLED:
        return 0
    rows = db.query(PushToken).filter(PushToken.user_id == user_id).all()
    if not rows:
        return 0
    messages = [
        {
            "to": r.token,
            "title": title,
            "body": body,
            "sound": "default",
            "data": data or {},
        }
        for r in rows
    ]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(EXPO_PUSH_URL, json=messages)
        tickets = (resp.json() or {}).get("data") or []
    except Exception:
        logger.warning("push: Expo send failed for user %s", user_id, exc_info=True)
        return 0
    ok = 0
    for row, ticket in zip(rows, tickets):
        if ticket.get("status") == "ok":
            ok += 1
        elif (ticket.get("details") or {}).get("error") == "DeviceNotRegistered":
            db.delete(row)
    db.commit()
    return ok


def _order_time(order: dict) -> Optional[datetime]:
    raw = order.get("creationDate")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def is_recent_order(order: dict, now: Optional[datetime] = None) -> bool:
    when = _order_time(order)
    if when is None:
        return False
    return (now or datetime.now(timezone.utc)) - when <= SALE_ALERT_MAX_AGE


def sale_message(order: dict) -> tuple[str, str]:
    lines = order.get("lineItems") or []
    title = (lines[0].get("title") if lines else None) or "An item"
    title = title[:80]
    if len(lines) > 1:
        title = f"{title} + {len(lines) - 1} more"
    total = ((order.get("pricingSummary") or {}).get("total") or {}).get("value")
    price = ""
    if total is not None:
        try:
            price = f" for ${Decimal(str(total)):,.2f}"
        except InvalidOperation:
            price = ""
    return "Sold on eBay", f"{title} sold{price}."


async def notify_ebay_sales(
    db: Session, user_id: uuid.UUID, new_orders: list[dict]
) -> int:
    """Alert for newly imported, recent eBay orders. Old/backfilled orders stay silent."""
    try:
        recent = [o for o in new_orders if is_recent_order(o)]
        if not recent:
            return 0
        if len(recent) > SALE_ALERT_BATCH_LIMIT:
            return await send_push(
                db,
                user_id,
                "Sold on eBay",
                f"{len(recent)} new eBay sales.",
                {"type": "ebay_sale"},
            )
        sent = 0
        for order in recent:
            title, body = sale_message(order)
            data = {"type": "ebay_sale", "orderId": str(order.get("orderId", ""))}
            sent += await send_push(db, user_id, title, body, data)
        return sent
    except Exception:
        logger.warning(
            "push: eBay sale alert failed for user %s", user_id, exc_info=True
        )
        return 0
