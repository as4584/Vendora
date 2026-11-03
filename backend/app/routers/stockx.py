"""StockX endpoints under /integrations/stockx/…"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.inventory import InventoryExternalLink, InventoryItem
from app.models.provider_outbox import ProviderOutbox
from app.models.stockx import StockxListing
from app.models.user import User
from app.services.stockx import (
    OPEN_LISTING_STATUSES,
    PROVIDER,
    StockxAPIError,
    process_job,
    process_outbox,
    stockx_service,
)

router = APIRouter(prefix="/integrations/stockx", tags=["integrations", "stockx"])

APP_REDIRECT = "vendora://settings?integration=stockx&status={status}"


# ── schemas ──────────────────────────────────────────────────────────────────

class StatusOut(BaseModel):
    configured: bool
    connected: bool
    account_id: Optional[str] = None
    expires_at: Optional[datetime] = None
    matched_items: int = 0
    open_listings: int = 0
    outbox_errors: int = 0


class AuthUrlOut(BaseModel):
    authorization_url: str


class CandidateOut(BaseModel):
    product_id: str
    title: str
    style_id: Optional[str] = None
    brand: Optional[str] = None
    colorway: Optional[str] = None
    score: float


class MatchOut(BaseModel):
    best: Optional[CandidateOut] = None
    shortlist: list[CandidateOut] = []


class VariantOut(BaseModel):
    variant_id: str
    size: str


class ConfirmIn(BaseModel):
    product_id: str = Field(min_length=1, max_length=100)
    # Optional manual size -> variantId picks from the sheet.
    sizes: dict[str, str] = {}


class LinkOut(BaseModel):
    product_id: Optional[str]
    variant_id: Optional[str]
    size: Optional[str]


class ListingOut(BaseModel):
    model_config = {"from_attributes": True}
    id: uuid.UUID
    inventory_item_id: uuid.UUID
    product_id: str
    variant_id: str
    size: Optional[str]
    listing_id: Optional[str]
    amount: Decimal
    currency_code: str
    status: str
    last_error: Optional[str]


class ItemOut(BaseModel):
    links: list[LinkOut]
    listings: list[ListingOut]


class MarketOut(BaseModel):
    product_id: str
    variant_id: str
    size: Optional[str] = None
    currency_code: str
    lowest_ask: Optional[Decimal] = None
    highest_bid: Optional[Decimal] = None
    last_sale: Optional[Decimal] = None
    fetched_at: datetime
    stale: bool = False


class ListingIn(BaseModel):
    variant_id: str = Field(min_length=1, max_length=100)
    amount: Decimal = Field(gt=0, max_digits=10, decimal_places=2)


class ListingUpdateIn(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=10, decimal_places=2)


class SyncOut(BaseModel):
    run_id: uuid.UUID
    transactions_imported: int
    transactions_existing: int
    skipped: int
    outbox_processed: int


class OutboxOut(BaseModel):
    model_config = {"from_attributes": True}
    id: uuid.UUID
    provider: str
    action: str
    status: str
    attempts: int
    max_attempts: int
    last_error: Optional[str]
    next_attempt_at: Optional[datetime]
    created_at: datetime


# ── helpers ──────────────────────────────────────────────────────────────────

def _item(db: Session, user: User, item_id: uuid.UUID) -> InventoryItem:
    item = (
        db.query(InventoryItem)
        .filter(InventoryItem.id == item_id, InventoryItem.user_id == user.id, InventoryItem.deleted_at.is_(None))
        .first()
    )
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Item not found")
    return item


def _listing(db: Session, user: User, listing_id: uuid.UUID) -> StockxListing:
    listing = (
        db.query(StockxListing)
        .filter(StockxListing.id == listing_id, StockxListing.user_id == user.id)
        .first()
    )
    if listing is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Listing not found")
    return listing


def _api_error(exc: StockxAPIError) -> HTTPException:
    code = status.HTTP_429_TOO_MANY_REQUESTS if exc.status_code == 429 else status.HTTP_502_BAD_GATEWAY
    return HTTPException(code, detail=f"StockX error: {exc.message}")


def _link_out(link: InventoryExternalLink) -> LinkOut:
    return LinkOut(product_id=link.external_parent_id, variant_id=link.external_sku, size=link.variant_label)


# ── OAuth ────────────────────────────────────────────────────────────────────

@router.get("/status", response_model=StatusOut)
def stockx_status(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    token = stockx_service.get_token(db, current_user.id)
    matched = (
        db.query(InventoryExternalLink.inventory_item_id)
        .filter(InventoryExternalLink.user_id == current_user.id, InventoryExternalLink.provider == PROVIDER)
        .distinct()
        .count()
    )
    open_listings = (
        db.query(StockxListing)
        .filter(StockxListing.user_id == current_user.id, StockxListing.status.in_(OPEN_LISTING_STATUSES))
        .count()
    )
    errors = (
        db.query(ProviderOutbox)
        .filter(
            ProviderOutbox.user_id == current_user.id,
            ProviderOutbox.provider == PROVIDER,
            ProviderOutbox.last_error.isnot(None),
            ProviderOutbox.status != "done",
        )
        .count()
    )
    return StatusOut(
        configured=stockx_service.is_configured(),
        connected=token is not None,
        account_id=token.account_id if token else None,
        expires_at=token.expires_at if token else None,
        matched_items=matched,
        open_listings=open_listings,
        outbox_errors=errors,
    )


@router.get("/connect", response_model=AuthUrlOut)
def stockx_connect(current_user: User = Depends(get_current_user)):
    state = stockx_service.build_state(current_user.id)
    return AuthUrlOut(authorization_url=stockx_service.authorization_url(state))


@router.get("/callback")
async def stockx_callback(
    state: str,
    code: Optional[str] = None,
    error: Optional[str] = None,
    db: Session = Depends(get_db),
):
    user_id = stockx_service.parse_state(state)
    if error or not code:
        return RedirectResponse(APP_REDIRECT.format(status="denied"), status_code=status.HTTP_303_SEE_OTHER)
    payload = await stockx_service.exchange_authorization_code(code)
    stockx_service.upsert_token(db, user_id=user_id, payload=payload)
    return RedirectResponse(APP_REDIRECT.format(status="connected"), status_code=status.HTTP_303_SEE_OTHER)


@router.delete("")
def stockx_disconnect(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    links = stockx_service.disconnect(db, current_user.id)
    return {"disconnected": True, "links_retained": links}


# ── match ────────────────────────────────────────────────────────────────────

@router.get("/items/{item_id}/match", response_model=MatchOut)
async def stockx_match_item(
    item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    item = _item(db, current_user, item_id)
    try:
        return await stockx_service.match_item(db, current_user.id, item)
    except StockxAPIError as exc:
        raise _api_error(exc) from exc


@router.get("/variants", response_model=list[VariantOut])
async def stockx_variants(
    product_id: str = Query(min_length=1, max_length=100), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    from app.services.stockx import variant_size

    try:
        variants = await stockx_service.get_variants(db, current_user.id, product_id)
    except StockxAPIError as exc:
        raise _api_error(exc) from exc
    return [VariantOut(variant_id=str(v.get("variantId")), size=variant_size(v)) for v in variants]


@router.post("/items/{item_id}/match", response_model=ItemOut)
async def stockx_confirm_match(
    item_id: uuid.UUID,
    body: ConfirmIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = _item(db, current_user, item_id)
    try:
        await stockx_service.confirm_match(db, current_user.id, item, body.product_id, body.sizes)
    except StockxAPIError as exc:
        raise _api_error(exc) from exc
    return _item_out(db, item)


def _item_out(db: Session, item: InventoryItem) -> ItemOut:
    listings = (
        db.query(StockxListing)
        .filter(StockxListing.inventory_item_id == item.id)
        .order_by(StockxListing.created_at.desc())
        .all()
    )
    return ItemOut(
        links=[_link_out(link) for link in stockx_service.links_for_item(db, item.id)],
        listings=[ListingOut.model_validate(row) for row in listings],
    )


@router.get("/items/{item_id}", response_model=ItemOut)
def stockx_item(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return _item_out(db, _item(db, current_user, item_id))


@router.get("/items/{item_id}/market", response_model=list[MarketOut])
async def stockx_item_market(
    item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    item = _item(db, current_user, item_id)
    out: list[MarketOut] = []
    for link in stockx_service.links_for_item(db, item.id):
        data = await stockx_service.market_data(db, current_user.id, link.external_parent_id or "", link.external_sku or "")
        out.append(MarketOut(**data, size=link.variant_label))
    return out


# ── asks ─────────────────────────────────────────────────────────────────────

@router.post("/items/{item_id}/listings", response_model=ListingOut, status_code=status.HTTP_201_CREATED)
async def stockx_create_listing(
    item_id: uuid.UUID,
    body: ListingIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = _item(db, current_user, item_id)
    return await stockx_service.create_listing(db, current_user.id, item, body.variant_id, body.amount)


@router.patch("/listings/{listing_id}", response_model=ListingOut)
async def stockx_update_listing(
    listing_id: uuid.UUID,
    body: ListingUpdateIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    listing = _listing(db, current_user, listing_id)
    return await stockx_service.update_listing(db, current_user.id, listing, body.amount)


@router.delete("/listings/{listing_id}", response_model=ListingOut)
async def stockx_delete_listing(
    listing_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    listing = _listing(db, current_user, listing_id)
    try:
        return await stockx_service.delete_listing(db, current_user.id, listing)
    except StockxAPIError as exc:
        raise _api_error(exc) from exc


# ── orders + outbox ──────────────────────────────────────────────────────────

@router.post("/sync", response_model=SyncOut)
async def stockx_sync(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    stockx_service.require_token(db, current_user.id)
    try:
        result = await stockx_service.sync(db, current_user.id)
    except StockxAPIError as exc:
        raise _api_error(exc) from exc
    processed = await process_outbox(db, user_id=current_user.id)
    return SyncOut(
        run_id=result.run_id,
        transactions_imported=result.transactions_imported,
        transactions_existing=result.transactions_updated,
        skipped=result.items_skipped,
        outbox_processed=processed,
    )


@router.get("/outbox", response_model=list[OutboxOut])
def stockx_outbox(
    only_errors: bool = Query(True),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(ProviderOutbox).filter(
        ProviderOutbox.user_id == current_user.id, ProviderOutbox.provider == PROVIDER
    )
    if only_errors:
        query = query.filter(ProviderOutbox.status != "done", ProviderOutbox.last_error.isnot(None))
    return query.order_by(ProviderOutbox.created_at.desc()).limit(100).all()


@router.post("/outbox/{job_id}/retry", response_model=OutboxOut)
async def stockx_outbox_retry(
    job_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    job = (
        db.query(ProviderOutbox)
        .filter(
            ProviderOutbox.id == job_id,
            ProviderOutbox.user_id == current_user.id,
            ProviderOutbox.provider == PROVIDER,
        )
        .first()
    )
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Job not found")
    if job.status == "done":
        return job
    if job.attempts >= job.max_attempts:
        job.max_attempts = job.attempts + 1  # a manual retry always gets one more try
    job.status = "pending"
    job.next_attempt_at = datetime.now(timezone.utc)
    db.commit()
    await process_job(db, job)
    db.refresh(job)
    return job
