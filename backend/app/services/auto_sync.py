"""Automatic background sync for every connected marketplace and POS.

Sellers never press a sync button: the outbox sweep calls ``run_due`` every minute,
and each connection is pulled when its last run is older than its interval.
One user's failure never stops the others.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.models.provider import ProviderSyncRun

logger = logging.getLogger(__name__)

TRIGGER = "scheduled"


@dataclass(frozen=True)
class Job:
    provider: str
    token_model: Any
    run: Callable[[Session, uuid.UUID], Awaitable[Any]]
    minutes: int


def _jobs() -> list[Job]:
    # Imported lazily: these modules pull in HTTP clients and settings.
    from app.models.clover import CloverCredential
    from app.models.integration import EbayToken, LightspeedToken
    from app.models.square import SquareCredential
    from app.models.stockx import StockxToken
    from app.services.clover import clover_service
    from app.services.ebay import ebay_service
    from app.services.ebay_insights import sync_finances
    from app.services.lightspeed import lightspeed_service
    from app.services.outbox import process_outbox
    from app.services.square import square_service
    from app.services.stockx import stockx_service

    every = settings.AUTO_SYNC_MINUTES

    async def ebay(db: Session, uid: uuid.UUID) -> None:
        await ebay_service.sync(db, uid, trigger_type=TRIGGER)
        # Real fees/payouts ride along so profit is right without a button.
        try:
            await sync_finances(db, uid, days=30)
        except Exception:  # noqa: BLE001 - fees are a bonus; never fail the order sync
            db.rollback()
            logger.warning("auto-sync: eBay fees pull failed", exc_info=True)

    async def stockx(db: Session, uid: uuid.UUID) -> None:
        await stockx_service.sync(db, uid, trigger_type=TRIGGER)
        await process_outbox(db, user_id=uid)

    def plain(service):
        async def go(db: Session, uid: uuid.UUID) -> None:
            await service.sync(db, uid, trigger_type=TRIGGER)

        return go

    return [
        Job("ebay", EbayToken, ebay, every),
        Job("stockx", StockxToken, stockx, every),
        Job("lightspeed", LightspeedToken, plain(lightspeed_service), every),
        Job("square", SquareCredential, plain(square_service), every),
        Job("clover", CloverCredential, plain(clover_service), every),
    ]


def _last_runs(db: Session, provider: str) -> dict[uuid.UUID, datetime]:
    rows = (
        db.query(ProviderSyncRun.user_id, func.max(ProviderSyncRun.started_at))
        .filter(ProviderSyncRun.provider == provider)
        .group_by(ProviderSyncRun.user_id)
        .all()
    )
    return {uid: ts for uid, ts in rows}


def _aware(ts: Optional[datetime]) -> Optional[datetime]:
    if ts is None:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def due_users(db: Session, job: Job, now: datetime) -> list[uuid.UUID]:
    connected = {row[0] for row in db.query(job.token_model.user_id).distinct().all()}
    last = _last_runs(db, job.provider)
    cutoff = now - timedelta(minutes=job.minutes)
    due = []
    for uid in connected:
        ts = _aware(last.get(uid))
        if ts is None or ts <= cutoff:
            due.append(uid)
    return sorted(due, key=lambda u: _aware(last.get(u)) or datetime.min.replace(tzinfo=timezone.utc))


async def run_due(
    db: Session, now: Optional[datetime] = None, jobs: Optional[list[Job]] = None
) -> dict[str, int]:
    """Sync every connection that is due. Returns {provider: connections synced}."""
    if not settings.AUTO_SYNC_ENABLED:
        return {}
    now = now or datetime.now(timezone.utc)
    done: dict[str, int] = {}
    for job in jobs if jobs is not None else _jobs():
        count = 0
        for uid in due_users(db, job, now)[: settings.AUTO_SYNC_BATCH]:
            try:
                await job.run(db, uid)
                count += 1
            except Exception:  # noqa: BLE001 - the run row records the failure
                db.rollback()
                logger.warning("auto-sync: %s failed for a user", job.provider, exc_info=True)
        done[job.provider] = count
    return done
