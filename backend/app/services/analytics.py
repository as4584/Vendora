"""Record and summarize funnel events. Never raises into the caller's request."""

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.app_event import AppEvent

logger = logging.getLogger(__name__)

# Client-sent events must be in this list; keeps the table small and free of PII.
CLIENT_EVENTS = frozenset(
    {
        "app_open",
        "onboarding_step",
        "onboarding_dismissed",
        "paywall_view",
        "purchase_start",
        "purchase_success",
        "purchase_cancel",
        "purchase_error",
        "trial_start",
        "rating_prompt_shown",
        "scan_used",
    }
)
SERVER_EVENTS = frozenset({"signup", "item_created", "sale_recorded"})
FUNNEL = ("signup", "item_created", "sale_recorded", "paywall_view", "purchase_success")
MAX_PROPS_KEYS = 10


def clean_props(props: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not props:
        return None
    out: dict[str, Any] = {}
    for k, v in list(props.items())[:MAX_PROPS_KEYS]:
        if isinstance(v, (bool, int, float)) or v is None:
            out[str(k)[:40]] = v
        elif isinstance(v, str):
            out[str(k)[:40]] = v[:100]
    return out or None


def track(
    db: Session,
    user_id: Optional[uuid.UUID],
    name: str,
    props: Optional[dict[str, Any]] = None,
) -> None:
    """Best-effort insert in its own savepoint so a failure can't break the caller."""
    try:
        with db.begin_nested():
            db.add(AppEvent(user_id=user_id, name=name, props=clean_props(props)))
    except Exception:
        logger.warning("analytics: could not record %s", name, exc_info=True)


def track_first(
    db: Session, user_id: uuid.UUID, name: str, props: Optional[dict[str, Any]] = None
) -> None:
    """Record only the user's first occurrence (funnel milestones)."""
    try:
        if (
            db.query(AppEvent.id)
            .filter(AppEvent.user_id == user_id, AppEvent.name == name)
            .first()
        ):
            return
    except Exception:
        logger.warning("analytics: lookup failed for %s", name, exc_info=True)
        return
    track(db, user_id, name, props)


def funnel(db: Session, days: int = 30) -> dict[str, Any]:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (
        db.query(AppEvent.name, func.count(func.distinct(AppEvent.user_id)))
        .filter(AppEvent.created_at >= since, AppEvent.name.in_(FUNNEL))
        .group_by(AppEvent.name)
        .all()
    )
    counts = dict(rows)
    return {
        "days": days,
        "steps": [{"name": n, "users": int(counts.get(n, 0))} for n in FUNNEL],
    }
