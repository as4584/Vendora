"""Shared provider outbox: one table, one enqueue path, one processor.

``enqueue_stock_change`` is called from every stock mutation (deduct_stock,
restore_stock, manual quantity edits) inside the caller's transaction and fans
out per provider link:

  - StockX: a size that sold out gets a ``delete_listing`` job per open ask.
  - eBay:   an item with an active listing gets a ``sync_quantity`` job that
            pushes min(listed cap, stock) — or ends the listing at zero.

Nothing here commits during enqueue, so a job exists iff the sale commits.
``process_outbox`` handles due jobs for every provider; ``outbox_worker`` runs
it after commit and on a periodic sweep. Failures back off exponentially and
stop as ``failed`` after ``max_attempts``; a manual retry grants one more try.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.inventory import InventoryExternalLink, InventoryItem
from app.models.provider_outbox import ProviderOutbox

EBAY = "ebay"
EBAY_SYNC_QUANTITY = "sync_quantity"
BACKOFF_BASE = timedelta(seconds=30)
BACKOFF_MAX = timedelta(hours=1)


def backoff_for(attempts: int) -> timedelta:
    return min(BACKOFF_BASE * (2 ** min(max(attempts - 1, 0), 16)), BACKOFF_MAX)


# ─── Enqueue ───────────────────────────────────────────────────────────────────

def _has_active_ebay_listing(db: Session, item: InventoryItem) -> bool:
    return (
        db.query(InventoryExternalLink.id)
        .filter(
            InventoryExternalLink.inventory_item_id == item.id,
            InventoryExternalLink.provider == EBAY,
            InventoryExternalLink.offer_id.isnot(None),
            InventoryExternalLink.listing_status == "active",
        )
        .first()
        is not None
    )


def enqueue_ebay_quantity(db: Session, item: InventoryItem, *, source_type: Optional[str] = None) -> Optional[ProviderOutbox]:
    """Queue an eBay quantity push if *item* has an active eBay listing.

    Sales that came FROM eBay are skipped (eBay already lowered its quantity).
    Coalesces into an existing pending job for the same item: the job reads
    stock when it runs, so one push covers every change before it.
    """
    if source_type == EBAY or item.id is None or not _has_active_ebay_listing(db, item):
        return None
    now = datetime.now(timezone.utc)
    existing = (
        db.query(ProviderOutbox)
        .filter(
            ProviderOutbox.provider == EBAY,
            ProviderOutbox.action == EBAY_SYNC_QUANTITY,
            ProviderOutbox.inventory_item_id == item.id,
            ProviderOutbox.status == "pending",
        )
        .first()
    )
    if existing:
        existing.next_attempt_at = now
        db.add(existing)
        db.info["provider_outbox_pending"] = True
        return existing
    job = ProviderOutbox(
        user_id=item.user_id,
        provider=EBAY,
        action=EBAY_SYNC_QUANTITY,
        inventory_item_id=item.id,
        payload={"inventory_item_id": str(item.id)},
        idempotency_key=f"ebay:sync_quantity:{item.id}:{uuid.uuid4().hex}",
        status="pending",
        attempts=0,
        next_attempt_at=now,
    )
    db.add(job)
    db.flush()
    db.info["provider_outbox_pending"] = True
    return job


def enqueue_stock_change(db: Session, item: InventoryItem, *, source_type: Optional[str] = None) -> None:
    """The one enqueue path for stock mutations: fan out per provider link."""
    from app.services.stockx import enqueue_sellout_delists

    from app.services.google_sheets import enqueue_sheet_push

    enqueue_sellout_delists(db, item)
    enqueue_ebay_quantity(db, item, source_type=source_type)
    enqueue_sheet_push(db, item, source_type=source_type)


# ─── Processing ────────────────────────────────────────────────────────────────

def _error_text(exc: Exception) -> str:
    detail = getattr(exc, "detail", None)
    if isinstance(detail, dict):
        detail = detail.get("message") or str(detail)
    return str(detail or getattr(exc, "message", None) or exc or exc.__class__.__name__)[:2000]


def _is_retryable(exc: Exception) -> bool:
    from app.services.ebay_listing import EbayApiError
    from app.services.google_sheets import GoogleApiError

    if isinstance(exc, GoogleApiError):
        return exc.retryable or exc.status_code in (403, 404)
    if isinstance(exc, EbayApiError):
        return exc.retryable or exc.ebay_status in (401, 403, 409)
    if isinstance(exc, HTTPException):
        # Not connected / reconnect needed: the seller can fix it, keep retrying.
        return exc.status_code in (401, 409, 502, 503)
    return True


async def _run_ebay(db: Session, job: ProviderOutbox):
    from app.services.ebay_listing import sync_listing_quantity

    if job.action != EBAY_SYNC_QUANTITY or job.inventory_item_id is None:
        raise ValueError(f"unknown job {job.provider}/{job.action}")
    return await sync_listing_quantity(db, job.inventory_item_id)


async def _run_google_sheets(db: Session, job: ProviderOutbox):
    from app.services.google_sheets import PUSH_ROW, google_sheets_service

    if job.action != PUSH_ROW or job.inventory_item_id is None:
        raise ValueError(f"unknown job {job.provider}/{job.action}")
    return await google_sheets_service.push_row(db, job)


async def _process_ebay_job(db: Session, job: ProviderOutbox, now: datetime, runner=_run_ebay) -> None:
    job_id = job.id
    job.status = "processing"
    job.attempts = (job.attempts or 0) + 1
    db.commit()
    try:
        outcome = await runner(db, job)
    except Exception as exc:  # noqa: BLE001 - every failure is recorded on the job
        db.rollback()
        job = db.get(ProviderOutbox, job_id)
        if job is None:
            return
        job.last_error = _error_text(exc)
        if job.attempts >= job.max_attempts or not _is_retryable(exc):
            job.status = "failed"
            job.next_attempt_at = None
        else:
            job.status = "pending"
            job.next_attempt_at = now + backoff_for(job.attempts)
        db.commit()
        return
    job = db.get(ProviderOutbox, job_id)
    if job is None:
        return
    job.status = "done"
    job.last_error = None
    job.completed_at = now
    job.next_attempt_at = None
    job.payload = {**(job.payload or {}), "outcome": outcome}
    db.commit()


async def process_job(db: Session, job: ProviderOutbox, now: Optional[datetime] = None) -> None:
    now = now or datetime.now(timezone.utc)
    if job.provider == EBAY:
        await _process_ebay_job(db, job, now)
    elif job.provider == "google_sheets":
        await _process_ebay_job(db, job, now, runner=_run_google_sheets)
    else:
        from app.services.stockx import process_job as stockx_process_job

        await stockx_process_job(db, job, now)


async def process_outbox(
    db: Session,
    user_id: Optional[uuid.UUID] = None,
    now: Optional[datetime] = None,
    limit: int = 50,
    provider: Optional[str] = None,
) -> int:
    """Run every due pending job (all providers unless *provider*). Returns how many ran."""
    now = now or datetime.now(timezone.utc)
    query = db.query(ProviderOutbox).filter(
        ProviderOutbox.status == "pending",
        ProviderOutbox.next_attempt_at <= now,
    )
    if user_id is not None:
        query = query.filter(ProviderOutbox.user_id == user_id)
    if provider is not None:
        query = query.filter(ProviderOutbox.provider == provider)
    jobs = query.order_by(ProviderOutbox.created_at).limit(limit).with_for_update(skip_locked=True).all()
    for job in jobs:
        await process_job(db, job, now)
    return len(jobs)


async def retry_job(db: Session, job: ProviderOutbox) -> ProviderOutbox:
    """Manual retry: always one more attempt, run now."""
    if job.status == "done":
        return job
    if job.attempts >= job.max_attempts:
        job.max_attempts = job.attempts + 1
    job.status = "pending"
    job.next_attempt_at = datetime.now(timezone.utc)
    db.commit()
    await process_job(db, job)
    db.refresh(job)
    return job
