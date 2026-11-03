"""Runs provider outbox jobs after commit, plus a periodic sweep for retries.

After a commit that wrote outbox rows (flagged via ``session.info``), a daemon
thread processes them with its own session, so the request never waits on
the marketplace. Anything that fails stays ``pending`` with backoff and is picked up
by the periodic sweep (started from the app lifespan) or a manual retry.
"""
from __future__ import annotations

import asyncio
import logging
import threading

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.config import settings

logger = logging.getLogger(__name__)

SWEEP_SECONDS = 60


def _run_once() -> None:
    from app.database import SessionLocal
    from app.services.outbox import process_outbox

    db = SessionLocal()
    try:
        asyncio.run(process_outbox(db))
    except Exception:  # noqa: BLE001 - worker must never crash the app
        logger.exception("provider outbox processing failed")
    finally:
        db.close()


def kick() -> None:
    threading.Thread(target=_run_once, name="provider-outbox", daemon=True).start()


@event.listens_for(Session, "after_commit")
def _after_commit(session: Session) -> None:
    if not session.info.pop("provider_outbox_pending", False):
        return
    if settings.ENVIRONMENT == "testing":
        return  # tests drive process_outbox directly
    kick()


async def sweep_forever() -> None:  # pragma: no cover - long-running loop
    while True:
        await asyncio.sleep(SWEEP_SECONDS)
        await asyncio.to_thread(_run_once)
