"""3rd-party integrations (Lightspeed, Square, etc.)."""
import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone
from typing import Optional
import uuid

import httpx

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.inventory import InventoryExternalLink
from app.models.provider import ProviderSyncRun, ReconciliationIssue
from app.models.square import SquareCredential
from app.models.user import User
from app.schemas.integration import (
    EbayPolicySetupRequest,
    LightspeedAuthURLResponse,
    LightspeedSyncResponse,
    LightspeedPushResponse,
    LightspeedDisconnectResponse,
    ProviderSyncRunResponse,
    ReconciliationIssueResponse,
    ReconciliationIssueUpdateRequest,
    SquareConnectRequest,
    SquareConnectResponse,
    SquareStatusResponse,
    SquareSyncResponse,
    CloverConnectRequest,
    CloverConnectResponse,
    CloverStatusResponse,
    CloverSyncResponse,
    SyncRetryResponse,
    ProviderHealthResponse,
    ProviderHealthEntry,
    EbayAuthURLResponse,
    EbayStatusResponse,
    EbaySyncResponse,
    EbayDisconnectResponse,
    EbayListingCreateRequest,
    EbayListingResponse,
    EbayListingUpdateRequest,
    EbayOfferRequest,
    OutboxJobResponse,
)
from app.services.lightspeed import lightspeed_service
from app.services.square import square_service
from app.services.clover import clover_service
from app.services.ebay import ebay_service
from app.services import ebay_signature
from app.services import ebay_listing
from app.services import ebay_policies
from app.services import ebay_insights
from app.services import outbox as outbox_service
from app.models.inventory import InventoryItem
from app.models.provider_outbox import ProviderOutbox
from app.services.providers.base import claim_webhook_event

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/integrations", tags=["integrations"])


# ─── Lightspeed ───────────────────────────────────────────────────────────────

@router.get("/lightspeed/status")
def lightspeed_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Returns whether the current user has connected their Lightspeed account."""
    token = lightspeed_service.get_token(db, current_user.id)
    if not token:
        return {"connected": False, "account_id": None, "expires_at": None, "last_synced_at": None}

    last_synced_scalar = (
        db.query(func.max(InventoryExternalLink.last_synced_at))
        .filter(
            InventoryExternalLink.user_id == current_user.id,
            InventoryExternalLink.provider == "lightspeed",
        )
        .scalar()
    )
    last_synced_at = last_synced_scalar.isoformat() if last_synced_scalar else None

    return {
        "connected": True,
        "account_id": token.account_id,
        "expires_at": token.expires_at.isoformat(),
        "last_synced_at": last_synced_at,
    }


@router.get("/lightspeed/connect", response_model=LightspeedAuthURLResponse)
async def lightspeed_connect(current_user: User = Depends(get_current_user)):
    """Return the OAuth URL so the reseller can authorize Resqlo."""
    state = lightspeed_service.build_state(current_user.id)
    return LightspeedAuthURLResponse(authorization_url=lightspeed_service.authorization_url(state))


@router.get("/lightspeed/callback")
async def lightspeed_callback(code: str, state: str, db: Session = Depends(get_db)):
    """Handle Lightspeed OAuth callback and persist tokens."""
    user_id = lightspeed_service.parse_state(state)
    token_payload = await lightspeed_service.exchange_authorization_code(code)
    raw_account_id = token_payload.get("account_id")
    if raw_account_id in (None, ""):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Lightspeed response missing account_id")
    account_id = str(raw_account_id)

    lightspeed_service.upsert_token(
        db,
        user_id=user_id,
        account_id=account_id,
        access_token=token_payload["access_token"],
        refresh_token=token_payload.get("refresh_token", ""),
        expires_at=token_payload["expires_at"],
        scopes=token_payload.get("scope"),
    )
    return RedirectResponse(settings.INTEGRATION_SUCCESS_URL, status_code=status.HTTP_303_SEE_OTHER)


@router.post("/lightspeed/sync", response_model=LightspeedSyncResponse)
async def lightspeed_sync(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One-way sync: pull latest inventory and sales from Lightspeed into Resqlo."""
    result = await lightspeed_service.sync(db, current_user.id)
    return LightspeedSyncResponse(
        status="completed" if result.errors_count == 0 else "partial",
        run_id=result.run_id,
        items_imported=result.items_imported,
        items_updated=result.items_updated,
        items_skipped=result.items_skipped,
        transactions_imported=result.transactions_imported,
        transactions_updated=result.transactions_updated,
        errors_count=result.errors_count,
    )


@router.post("/lightspeed/push", response_model=LightspeedPushResponse)
async def lightspeed_push_linked(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await lightspeed_service.push_linked_items(db, current_user.id)
    return LightspeedPushResponse(
        status="completed" if result["errors_count"] == 0 else "partial",
        items_updated=result["items_updated"],
        errors_count=result["errors_count"],
    )


@router.post("/lightspeed/items/{item_id}/push", response_model=LightspeedPushResponse)
async def lightspeed_push_item(
    item_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    created = await lightspeed_service.push_item(db, current_user.id, item_id)
    return LightspeedPushResponse(items_created=1 if created else 0, items_updated=0 if created else 1)


@router.delete("/lightspeed", response_model=LightspeedDisconnectResponse)
def lightspeed_disconnect(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    links = lightspeed_service.disconnect(db, current_user.id)
    return LightspeedDisconnectResponse(disconnected=True, links_retained=links)


# ─── eBay ───────────────────────────────────────────────────────────

@router.get("/ebay/status", response_model=EbayStatusResponse)
def ebay_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return whether the current user has connected their eBay account."""
    token = ebay_service.get_token(db, current_user.id)
    if not token:
        return EbayStatusResponse(connected=False, environment=ebay_service.env)

    last_synced_scalar = (
        db.query(func.max(InventoryExternalLink.last_synced_at))
        .filter(
            InventoryExternalLink.user_id == current_user.id,
            InventoryExternalLink.provider == "ebay",
        )
        .scalar()
    )
    return EbayStatusResponse(
        connected=True,
        account_id=token.account_id,
        expires_at=token.expires_at.isoformat(),
        last_synced_at=last_synced_scalar.isoformat() if last_synced_scalar else None,
        can_list=bool(token.scopes) and ebay_listing._has_scope(token.scopes, "sell.inventory"),
        environment=ebay_service.env,
        missing_scopes=[
            sc.rsplit("/", 1)[-1]
            for sc in ebay_service.requested_scopes
            if not sc.endswith("/api_scope")
            and not (token.scopes and ebay_listing._has_scope(token.scopes, sc.rsplit("/", 1)[-1]))
        ],
    )


@router.get("/ebay/connect", response_model=EbayAuthURLResponse)
async def ebay_connect(current_user: User = Depends(get_current_user)):
    """Return the eBay OAuth consent URL so the reseller can authorize Resqlo."""
    state = ebay_service.build_state(current_user.id)
    return EbayAuthURLResponse(authorization_url=ebay_service.authorization_url(state))


@router.get("/ebay/callback")
async def ebay_callback(code: str, state: str, db: Session = Depends(get_db)):
    """Handle the eBay OAuth callback and persist tokens."""
    user_id = ebay_service.parse_state(state)
    token_payload = await ebay_service.exchange_authorization_code(code)
    username = await ebay_service.fetch_username(token_payload["access_token"])
    ebay_service.upsert_token(
        db,
        user_id=user_id,
        account_id=username,
        access_token=token_payload["access_token"],
        refresh_token=token_payload.get("refresh_token", ""),
        expires_at=token_payload["expires_at"],
        # eBay's code exchange omits the granted scope; record what we requested.
        scopes=token_payload.get("scope") or " ".join(ebay_service.requested_scopes),
    )
    return RedirectResponse(
        "vendora://settings?integration=ebay&status=connected",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.post("/ebay/sync", response_model=EbaySyncResponse)
async def ebay_sync(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Pull-only sync: import eBay inventory items and orders into Resqlo."""
    result = await ebay_service.sync(db, current_user.id)
    return EbaySyncResponse(
        status="completed" if result.errors_count == 0 else "partial",
        run_id=result.run_id,
        items_imported=result.items_imported,
        items_updated=result.items_updated,
        items_skipped=result.items_skipped,
        transactions_imported=result.transactions_imported,
        transactions_updated=result.transactions_updated,
        errors_count=result.errors_count,
    )


@router.delete("/ebay", response_model=EbayDisconnectResponse)
def ebay_disconnect(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    links = ebay_service.disconnect(db, current_user.id)
    return EbayDisconnectResponse(disconnected=True, links_retained=links)


# ─── eBay listings (write-back) ────────────────────────────────────────────────

def _listing_response(item_id: uuid.UUID, payload: dict) -> EbayListingResponse:
    return EbayListingResponse(item_id=item_id, **payload)


@router.post("/ebay/listings", response_model=EbayListingResponse, status_code=status.HTTP_201_CREATED)
async def ebay_create_listing(
    body: EbayListingCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List an item on eBay: inventory item -> offer -> publish."""
    payload = await ebay_listing.create_listing(
        db,
        current_user,
        body.item_id,
        price=body.price,
        quantity=body.quantity,
        title=body.title,
        condition=body.condition,
        category_id=body.category_id,
        description=body.description,
        postal_code=body.postal_code,
    )
    return _listing_response(body.item_id, payload)


@router.get("/ebay/policies")
async def ebay_get_policies(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The seller's EBAY_US business policies and which kinds are missing."""
    return await ebay_policies.policy_overview(db, current_user.id)


@router.post("/ebay/policies/setup")
async def ebay_setup_policies(
    body: EbayPolicySetupRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Opt in to business policies and create any missing Resqlo default policies."""
    return await ebay_policies.setup_policies(
        db,
        current_user.id,
        free_shipping=body.free_shipping,
        flat_shipping_cost=body.flat_shipping_cost,
        returns_accepted=body.returns_accepted,
    )


@router.get("/ebay/listings/{item_id}", response_model=EbayListingResponse)
def ebay_get_listing(
    item_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Listing status for an item (listed=false when it has no eBay listing)."""
    owned = (
        db.query(InventoryItem.id)
        .filter(
            InventoryItem.id == item_id,
            InventoryItem.user_id == current_user.id,
            InventoryItem.deleted_at.is_(None),
        )
        .first()
    )
    if owned is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found.")
    link =ebay_listing.get_ebay_link(db, current_user.id, item_id)
    return _listing_response(item_id, ebay_listing.link_payload(link))


@router.patch("/ebay/listings/{item_id}", response_model=EbayListingResponse)
async def ebay_update_listing(
    item_id: uuid.UUID,
    body: EbayListingUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Revise price and/or quantity (bulkUpdatePriceQuantity). Quantity 0 ends it."""
    payload = await ebay_listing.update_listing(
        db, current_user, item_id, price=body.price, quantity=body.quantity
    )
    return _listing_response(item_id, payload)


@router.delete("/ebay/listings/{item_id}", response_model=EbayListingResponse)
async def ebay_end_listing(
    item_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """End the eBay listing (withdrawOffer). The offer is kept so it can be relisted."""
    payload = await ebay_listing.end_listing(db, current_user, item_id)
    return _listing_response(item_id, payload)


@router.get("/ebay/comps")
async def ebay_comps(
    q: str = Query(..., min_length=2, max_length=100),
    condition: Optional[str] = Query(None, pattern="^(new|used)$"),
    current_user: User = Depends(get_current_user),
):
    """eBay price comps (active asks unless sold data is enabled; see ``kind``)."""
    return await ebay_listing.fetch_comps(q, condition=condition)


@router.get("/ebay/images/{item_id}/{side}/{signature}.jpg", include_in_schema=False)
def ebay_listing_image(
    item_id: uuid.UUID,
    side: str,
    signature: str,
    db: Session = Depends(get_db),
):
    """Public, signed image URL for eBay to fetch item photos stored as data URLs."""
    if side not in ("front", "back") or not hmac.compare_digest(
        signature, ebay_listing.image_signature(item_id, side)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    item = (
        db.query(InventoryItem)
        .filter(InventoryItem.id == item_id, InventoryItem.deleted_at.is_(None))
        .one_or_none()
    )
    value = (item.photo_front_url if side == "front" else item.photo_back_url) if item else None
    if not value or not value.startswith("data:image/"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    try:
        data, media = ebay_listing.decode_data_url(value)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return Response(
        content=data,
        media_type=media,
        headers={
            "Cache-Control": "public, max-age=3600",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


# ─── eBay insights: fees + payouts, traffic, offers, notifications ───────────

@router.post("/ebay/finances/sync")
async def ebay_finances_sync(
    days: int = Query(90, ge=1, le=365),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Pull eBay fees (per order) and payouts; set real fees/net on imported orders."""
    return await ebay_insights.sync_finances(db, current_user.id, days=days)


@router.get("/ebay/payouts")
def ebay_payouts(
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """eBay payouts with reconciliation against imported orders."""
    from app.models.ebay_insights import EbayPayout

    rows = (
        db.query(EbayPayout)
        .filter(EbayPayout.user_id == current_user.id)
        .order_by(EbayPayout.payout_date.desc().nullslast())
        .limit(limit)
        .all()
    )
    return [ebay_insights.payout_payload(p) for p in rows]


@router.get("/ebay/fees")
def ebay_fees(
    order_id: Optional[str] = Query(None, max_length=100),
    transaction_id: Optional[uuid.UUID] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Per-order eBay fee breakdown (recent orders, or one by order/transaction id)."""
    rows = ebay_insights.item_fee_rows(db, current_user.id, limit=200 if (order_id or transaction_id) else 50)
    if order_id:
        rows = [r for r in rows if r["order_id"] == order_id]
    if transaction_id:
        rows = [r for r in rows if r["transaction_id"] == str(transaction_id)]
    return rows


@router.get("/ebay/listings/{item_id}/traffic")
async def ebay_listing_traffic(
    item_id: uuid.UUID,
    refresh: bool = Query(False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Views, impressions, CTR, conversion and watchers (cached daily)."""
    return await ebay_insights.listing_traffic(db, current_user, item_id, refresh=refresh)


@router.get("/ebay/listings/{item_id}/offers/eligibility")
async def ebay_offer_eligibility(
    item_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await ebay_insights.offer_eligibility(db, current_user, item_id)


@router.post("/ebay/listings/{item_id}/offers")
async def ebay_send_offer(
    item_id: uuid.UUID,
    body: EbayOfferRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Send an offer to buyers watching this listing (Negotiation API)."""
    return await ebay_insights.send_offer(
        db, current_user, item_id, price=body.price, discount_percent=body.discount_percent,
        duration_days=body.duration_days, message=body.message, quantity=body.quantity,
    )


@router.post("/ebay/notifications/subscribe")
async def ebay_notifications_subscribe(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Subscribe this seller to order notifications (real-time import)."""
    return await ebay_insights.subscribe_orders(db, current_user.id)


@router.get("/ebay/notifications")
def ebay_notifications_challenge(challenge_code: str = Query(...)):
    """Destination validation challenge (same hash scheme as account deletion)."""
    token = settings.EBAY_VERIFICATION_TOKEN
    if not token:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="eBay notifications not configured.")
    digest = hashlib.sha256(
        (challenge_code + token + settings.EBAY_NOTIFICATION_ENDPOINT).encode("utf-8")
    ).hexdigest()
    return {"challengeResponse": digest}


@router.post("/ebay/notifications", status_code=status.HTTP_200_OK)
async def ebay_notifications(request: Request, db: Session = Depends(get_db)):
    """Real-time order notifications. Verified like account deletion (412 on a
    bad signature). The order is imported via the same idempotent path as the
    polling sync; on any failure we still return 200 and polling catches up."""
    body = await request.body()
    try:
        await ebay_signature.verify_request(ebay_service, body, request.headers.get("x-ebay-signature"))
    except ebay_signature.SignatureError as exc:
        logger.warning("Rejected eBay notification: %s", exc)
        raise HTTPException(status_code=status.HTTP_412_PRECONDITION_FAILED, detail="Invalid signature.")
    except httpx.HTTPError:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Could not verify signature.")
    try:
        payload = json.loads(body)
    except ValueError:
        return {"ok": True, "status": "ignored"}
    topic = str(((payload or {}).get("metadata") or {}).get("topic") or "").upper()
    notification = (payload or {}).get("notification") or {}
    data = notification.get("data") or {}
    if topic not in ebay_insights.order_topics():
        return {"ok": True, "status": "ignored"}
    order_id = ebay_insights.extract_order_id(data)
    token = ebay_insights.resolve_seller(db, data)
    event_id = str(notification.get("notificationId") or f"{topic}:{order_id}")
    if not order_id or token is None:
        return {"ok": True, "status": "unmatched"}
    evt, created = claim_webhook_event(
        db, provider="ebay", event_id=event_id, event_type=topic,
        raw_payload=body.decode("utf-8", errors="replace")[:20000], user_id=token.user_id,
    )
    if not created and (evt.processed or not evt.error):
        return {"ok": True, "status": "duplicate"}
    db.commit()
    try:
        await ebay_insights.import_order_now(db, token.user_id, order_id)
        evt = db.get(type(evt), evt.id)
        evt.processed = True
        evt.error = None
        db.commit()
    except Exception as exc:  # noqa: BLE001 - polling sync is the fallback
        db.rollback()
        evt = db.get(type(evt), evt.id)
        if evt is not None:
            evt.error = str(getattr(exc, "detail", exc))[:2000]
            db.commit()
        logger.warning("eBay notification import failed for order %s: %s", order_id, exc)
        return {"ok": True, "status": "deferred"}
    return {"ok": True, "status": "imported", "order_id": order_id}


# ─── Provider outbox (marketplace write queue) ────────────────────────────────

def _outbox_response(job: ProviderOutbox, names: dict) -> OutboxJobResponse:
    resp = OutboxJobResponse.model_validate(job)
    resp.item_name = names.get(job.inventory_item_id)
    return resp


def _item_names(db: Session, jobs: list[ProviderOutbox]) -> dict:
    """Item name per job: the item column (eBay) or the StockX listing's item."""
    from app.models.stockx import StockxListing

    item_ids = {j.inventory_item_id for j in jobs if j.inventory_item_id}
    listing_ids = set()
    for j in jobs:
        raw = (j.payload or {}).get("stockx_listing_id") if not j.inventory_item_id else None
        if raw:
            try:
                listing_ids.add(uuid.UUID(str(raw)))
            except ValueError:
                pass
    listing_item = dict(
        db.query(StockxListing.id, StockxListing.inventory_item_id).filter(StockxListing.id.in_(listing_ids)).all()
    ) if listing_ids else {}
    item_ids |= set(listing_item.values())
    names = dict(
        db.query(InventoryItem.id, InventoryItem.name).filter(InventoryItem.id.in_(item_ids)).all()
    ) if item_ids else {}
    out = {}
    for j in jobs:
        iid = j.inventory_item_id
        if iid is None:
            raw = (j.payload or {}).get("stockx_listing_id")
            try:
                iid = listing_item.get(uuid.UUID(str(raw))) if raw else None
            except ValueError:
                iid = None
        out[j.id] = names.get(iid)
    return out


def _outbox_response(job: ProviderOutbox, names: dict) -> OutboxJobResponse:
    resp = OutboxJobResponse.model_validate(job)
    resp.item_name = names.get(job.id)
    return resp


@router.get("/outbox", response_model=list[OutboxJobResponse])
def list_outbox(
    only_errors: bool = Query(True, description="Only jobs that are not done and have an error"),
    provider: Optional[str] = Query(None, pattern="^(stockx|ebay)$"),
    limit: int = Query(100, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Marketplace write jobs for every provider (one list for Sync Center)."""
    q = db.query(ProviderOutbox).filter(ProviderOutbox.user_id == current_user.id)
    if provider:
        q = q.filter(ProviderOutbox.provider == provider)
    if only_errors:
        q = q.filter(ProviderOutbox.status != "done", ProviderOutbox.last_error.isnot(None))
    jobs = q.order_by(ProviderOutbox.created_at.desc()).limit(limit).all()
    names = _item_names(db, jobs)
    return [_outbox_response(j, names) for j in jobs]


@router.post("/outbox/{job_id}/retry", response_model=OutboxJobResponse)
async def retry_outbox_job(
    job_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Retry a failed marketplace write now (any provider)."""
    job = (
        db.query(ProviderOutbox)
        .filter(ProviderOutbox.id == job_id, ProviderOutbox.user_id == current_user.id)
        .one_or_none()
    )
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    job = await outbox_service.retry_job(db, job)
    return _outbox_response(job, _item_names(db, [job]))


# ─── eBay Marketplace Account Deletion (public; required for production) ─────────

@router.get("/ebay/deletion")
def ebay_deletion_challenge(challenge_code: str = Query(...)):
    """Respond to eBay's account-deletion validation challenge.

    eBay sends GET ?challenge_code=... and expects
    sha256(challengeCode + verificationToken + endpoint) hex as challengeResponse.
    The endpoint value MUST equal the URL configured in the eBay portal.
    """
    token = settings.EBAY_VERIFICATION_TOKEN
    endpoint = settings.EBAY_DELETION_ENDPOINT
    if not token:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="eBay deletion token not configured.")
    digest = hashlib.sha256((challenge_code + token + endpoint).encode("utf-8")).hexdigest()
    return {"challengeResponse": digest}


@router.post("/ebay/deletion", status_code=status.HTTP_200_OK)
async def ebay_deletion_notify(request: Request, db: Session = Depends(get_db)):
    """Handle eBay marketplace account-deletion notifications.

    eBay requires that we purge the eBay-linked data we hold for the deleted
    eBay account. We match on the eBay username/userId in the payload and
    remove only that account's eBay OAuth token and eBay inventory links —
    never the Resqlo account itself. Notices must carry a valid
    x-ebay-signature (412 otherwise, as eBay specifies); verified notices
    always get 200 so eBay stops retrying.
    """
    body = await request.body()
    try:
        await ebay_signature.verify_request(
            ebay_service, body, request.headers.get("x-ebay-signature")
        )
    except (ebay_signature.KeyUnavailableError, httpx.HTTPError) as exc:
        # We could not obtain eBay's key (other environment, keyset not yet
        # enabled, or eBay unreachable). Acknowledge so the endpoint stays
        # healthy for eBay, but take NO action: an unverified notice can never
        # purge anything.
        logger.warning("eBay deletion notice acknowledged without action (unverifiable): %s", exc)
        return {"ok": True, "verified": False}
    except ebay_signature.SignatureError as exc:
        logger.warning("Rejected eBay deletion notice: %s", exc)
        raise HTTPException(status_code=status.HTTP_412_PRECONDITION_FAILED, detail="Invalid signature.")

    try:
        payload = json.loads(body)
    except ValueError:
        return {"ok": True}

    data = ((payload or {}).get("notification") or {}).get("data") or {}
    identifiers = {
        str(data[k]) for k in ("username", "userId", "user_id") if data.get(k)
    }
    if not identifiers:
        return {"ok": True}

    from app.models.integration import EbayToken

    tokens = (
        db.query(EbayToken)
        .filter(EbayToken.account_id.in_(identifiers))
        .all()
    )
    for token in tokens:
        db.query(InventoryExternalLink).filter(
            InventoryExternalLink.user_id == token.user_id,
            InventoryExternalLink.provider == "ebay",
        ).delete(synchronize_session=False)
        db.delete(token)
    if tokens:
        db.commit()
        logger.info("Purged eBay data for %d account(s) on deletion notice.", len(tokens))
    return {"ok": True}


# ─── Square ───────────────────────────────────────────────────────────────────

@router.get("/square/status", response_model=SquareStatusResponse)
def square_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Returns whether the current user has connected their Square account."""
    cred = square_service._get_credential(db, current_user.id)
    if not cred:
        return SquareStatusResponse(
            connected=False, merchant_id=None, location_id=None, last_synced_at=None
        )

    last_synced_scalar = (
        db.query(func.max(InventoryExternalLink.last_synced_at))
        .filter(
            InventoryExternalLink.user_id == current_user.id,
            InventoryExternalLink.provider == "square",
        )
        .scalar()
    )
    last_synced_at = last_synced_scalar.isoformat() if last_synced_scalar else None

    return SquareStatusResponse(
        connected=True,
        merchant_id=cred.merchant_id,
        location_id=cred.location_id,
        last_synced_at=last_synced_at,
    )


@router.post("/square/connect", response_model=SquareConnectResponse)
def square_connect(
    body: SquareConnectRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Store Square API credentials for the current user.

    Accepts a Square access token (personal or OAuth) and an optional
    location_id.  The merchant_id can be provided or will be resolved
    automatically on the first sync.
    """
    cred = square_service.store_credential(
        db,
        user_id=current_user.id,
        access_token=body.access_token,
        merchant_id=body.merchant_id,
        location_id=body.location_id,
    )
    return SquareConnectResponse(
        message="Square account connected.",
        merchant_id=cred.merchant_id,
        location_id=cred.location_id,
    )


@router.post("/square/sync", response_model=SquareSyncResponse)
async def square_sync(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One-way import: pull Square catalog + inventory counts into Resqlo."""
    if not square_service.is_connected(db, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Square account not connected. Call POST /integrations/square/connect first.",
        )
    result = await square_service.sync(db, current_user.id)
    return SquareSyncResponse(
        status="completed" if result.errors_count == 0 else "partial",
        run_id=result.run_id,
        items_imported=result.items_imported,
        items_updated=result.items_updated,
        items_skipped=result.items_skipped,
        transactions_imported=result.transactions_imported,
        transactions_updated=result.transactions_updated,
        errors_count=result.errors_count,
    )


# ─── Clover ───────────────────────────────────────────────────────────────────

def _disconnect_credential(db: Session, user_id, provider: str, credential) -> LightspeedDisconnectResponse:
    """Forget the stored token; keep item links so a reconnect re-matches safely."""
    if credential:
        db.delete(credential)
        db.commit()
    links = db.query(InventoryExternalLink).filter(
        InventoryExternalLink.user_id == user_id,
        InventoryExternalLink.provider == provider,
    ).count()
    return LightspeedDisconnectResponse(disconnected=True, links_retained=links)


@router.delete("/square", response_model=LightspeedDisconnectResponse)
def square_disconnect(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return _disconnect_credential(db, current_user.id, "square", square_service._get_credential(db, current_user.id))


@router.delete("/clover", response_model=LightspeedDisconnectResponse)
def clover_disconnect(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return _disconnect_credential(db, current_user.id, "clover", clover_service._get_credential(db, current_user.id))


@router.get("/clover/status", response_model=CloverStatusResponse)
def clover_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Returns whether the current user has connected their Clover account."""
    cred = clover_service._get_credential(db, current_user.id)
    if not cred:
        return CloverStatusResponse(
            connected=False, merchant_id=None, last_synced_at=None
        )

    last_synced_scalar = (
        db.query(func.max(InventoryExternalLink.last_synced_at))
        .filter(
            InventoryExternalLink.user_id == current_user.id,
            InventoryExternalLink.provider == "clover",
        )
        .scalar()
    )
    last_synced_at = last_synced_scalar.isoformat() if last_synced_scalar else None

    return CloverStatusResponse(
        connected=True,
        merchant_id=cred.merchant_id,
        last_synced_at=last_synced_at,
    )


@router.post("/clover/connect", response_model=CloverConnectResponse)
def clover_connect(
    body: CloverConnectRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Store Clover API credentials for the current user.

    merchant_id is required for Clover — every v3 API call includes it in the
    request path as /v3/merchants/{mid}/...
    """
    cred = clover_service.store_credential(
        db,
        user_id=current_user.id,
        merchant_id=body.merchant_id,
        access_token=body.access_token,
    )
    return CloverConnectResponse(
        message="Clover account connected.",
        merchant_id=cred.merchant_id,
    )


@router.post("/clover/sync", response_model=CloverSyncResponse)
async def clover_sync(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One-way import: pull Clover items and stock into Resqlo."""
    if not clover_service.is_connected(db, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Clover account not connected. Call POST /integrations/clover/connect first.",
        )
    result = await clover_service.sync(db, current_user.id)
    return CloverSyncResponse(
        status="completed" if result.errors_count == 0 else "partial",
        run_id=result.run_id,
        items_imported=result.items_imported,
        items_updated=result.items_updated,
        items_skipped=result.items_skipped,
        transactions_imported=result.transactions_imported,
        transactions_updated=result.transactions_updated,
        errors_count=result.errors_count,
    )


# ─── Provider sync runs ───────────────────────────────────────────────────────

@router.get("/sync-runs", response_model=list[ProviderSyncRunResponse])
def list_sync_runs(
    provider: Optional[str] = Query(None, description="Filter by provider (lightspeed|square|clover)"),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List provider sync run history for the current user, newest first."""
    q = (
        db.query(ProviderSyncRun)
        .filter(ProviderSyncRun.user_id == current_user.id)
        .order_by(ProviderSyncRun.started_at.desc())
    )
    if provider:
        q = q.filter(ProviderSyncRun.provider == provider)
    return q.limit(limit).all()


@router.get("/sync-runs/{run_id}", response_model=ProviderSyncRunResponse)
def get_sync_run(
    run_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a specific provider sync run by ID."""
    run = (
        db.query(ProviderSyncRun)
        .filter(
            ProviderSyncRun.id == run_id,
            ProviderSyncRun.user_id == current_user.id,
        )
        .first()
    )
    if not run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sync run not found.")
    return run


# ─── Reconciliation issues ────────────────────────────────────────────────────

@router.get("/reconciliation-issues", response_model=list[ReconciliationIssueResponse])
def list_reconciliation_issues(
    provider: Optional[str] = Query(None),
    issue_status: Optional[str] = Query(None, alias="status"),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List reconciliation issues for the current user."""
    q = (
        db.query(ReconciliationIssue)
        .filter(ReconciliationIssue.user_id == current_user.id)
        .order_by(ReconciliationIssue.detected_at.desc())
    )
    if provider:
        q = q.filter(ReconciliationIssue.provider == provider)
    if issue_status:
        q = q.filter(ReconciliationIssue.status == issue_status)
    return q.limit(limit).all()


@router.patch("/reconciliation-issues/{issue_id}", response_model=ReconciliationIssueResponse)
def update_reconciliation_issue(
    issue_id: uuid.UUID,
    body: ReconciliationIssueUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Resolve or dismiss a reconciliation issue."""
    allowed = {"resolved", "dismissed"}
    if body.status not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"status must be one of: {sorted(allowed)}",
        )

    issue = (
        db.query(ReconciliationIssue)
        .filter(
            ReconciliationIssue.id == issue_id,
            ReconciliationIssue.user_id == current_user.id,
        )
        .first()
    )
    if not issue:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Issue not found.")

    issue.status = body.status
    issue.resolved_at = datetime.now(timezone.utc) if body.status in ("resolved", "dismissed") else issue.resolved_at
    if body.resolution_note is not None:
        issue.resolution_note = body.resolution_note
    db.add(issue)
    db.commit()
    db.refresh(issue)
    return issue



# ─── Square webhook ───────────────────────────────────────────────────────────

@router.post("/square/webhook", include_in_schema=False)
async def square_webhook(request: Request, db: Session = Depends(get_db)):
    """Receive Square webhook notifications (no auth — HMAC-verified).

    Idempotent: duplicate event_ids return 200 immediately without re-syncing.
    Supported event types:
      - inventory.count.updated  → triggers a Square sync for the affected merchant
      - catalog.version.updated  → triggers a Square sync for the affected merchant
    """
    body_bytes = await request.body()
    body_str = body_bytes.decode("utf-8", errors="replace")

    # ── HMAC-SHA256 signature verification ────────────────────────────────
    signature_key = settings.SQUARE_WEBHOOK_SIGNATURE_KEY
    if settings.ENVIRONMENT not in ("development", "testing") and not signature_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Square webhook verification is not configured.",
        )

    if signature_key:
        sig_header = request.headers.get("x-square-hmacsha256-signature", "")
        # Square computes HMAC-SHA256 of (notification_url + raw_body)
        url = settings.SQUARE_WEBHOOK_URL or str(request.url)
        mac = hmac.new(
            signature_key.encode("utf-8"),
            (url + body_str).encode("utf-8"),
            hashlib.sha256,
        )
        import base64
        expected = base64.b64encode(mac.digest()).decode()
        if not hmac.compare_digest(expected, sig_header):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid webhook signature.")

    try:
        payload = json.loads(body_str)
    except json.JSONDecodeError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON payload.")

    event_type = payload.get("type", "")
    event_id = payload.get("event_id") or payload.get("id", "")
    merchant_id = payload.get("merchant_id", "")
    actionable = {"inventory.count.updated", "catalog.version.updated"}
    if event_type in actionable and not event_id:
        raise HTTPException(status_code=400, detail="Webhook event is missing an id.")

    # Resolve user from merchant_id
    user_id: Optional[uuid.UUID] = None
    if merchant_id:
        cred = db.query(SquareCredential).filter_by(merchant_id=merchant_id).first()
        if cred:
            user_id = cred.user_id

    # Record the event (idempotent)
    if event_id:
        evt, created = claim_webhook_event(
            db,
            provider="square",
            event_id=event_id,
            event_type=event_type,
            raw_payload=body_str,
            user_id=user_id,
        )
        if not created:
            # Retry only a redelivery whose earlier sync errored out. An
            # already-processed event, or one still in flight from a concurrent
            # claim (no error recorded yet), is a genuine duplicate.
            if evt.processed or not evt.error:
                return {"status": "duplicate", "event_id": event_id}
        else:
            db.commit()
    else:
        evt = None

    # Only act on supported event types when we can resolve a user
    if event_type in actionable and user_id:
        try:
            result = await square_service.sync(
                db,
                user_id,
                trigger_type="webhook",
                triggered_by_event_id=evt.id,
            )
            evt.processed = True
            evt.error = None
            evt.sync_run_id = result.run_id
            db.add(evt)
            db.commit()
        except Exception as exc:
            # Clear the aborted transaction before recording the error, or the
            # error write itself would raise and return a 500.
            db.rollback()
            evt = db.get(type(evt), evt.id)
            if evt is not None:
                evt.error = str(exc)[:2000]
                evt.processed = False
                db.add(evt)
                db.commit()
            logger.exception("Square webhook sync failed for event %s", event_id)
            # 500 so Square redelivers; the next delivery retries the sync.
            raise HTTPException(status_code=500, detail="sync_failed") from exc
    return {"status": "ok", "event_id": event_id}


# ─── Sync retry ───────────────────────────────────────────────────────────────

@router.post("/sync-runs/{run_id}/retry", response_model=SyncRetryResponse)
async def retry_sync_run(
    run_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Retry a failed or partial sync run by creating a new run for the same provider.

    The original run is NOT modified.  A new ProviderSyncRun is created with
    trigger_type='retry' so callers can distinguish it in history.
    """
    original = (
        db.query(ProviderSyncRun)
        .filter(
            ProviderSyncRun.id == run_id,
            ProviderSyncRun.user_id == current_user.id,
        )
        .first()
    )
    if not original:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sync run not found.")

    provider_map = {
        "lightspeed": lightspeed_service,
        "square": square_service,
        "clover": clover_service,
    }
    svc = provider_map.get(original.provider)
    if svc is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Provider '{original.provider}' does not support retry.",
        )

    result = await svc.sync(db, current_user.id, trigger_type="retry")
    return SyncRetryResponse(
        message=f"{original.provider.capitalize()} sync retried.",
        new_run_id=result.run_id,
        status="completed" if result.errors_count == 0 else "partial",
        items_imported=result.items_imported,
        items_updated=result.items_updated,
        errors_count=result.errors_count,
    )


# ─── Provider health / observability ─────────────────────────────────────────

@router.get("/health", response_model=ProviderHealthResponse)
def provider_health(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return a per-provider health summary for the current user.

    Includes last run timestamp, last run status, count of failed runs in the
    past 24 hours, and count of currently open reconciliation issues.
    """
    providers = ["lightspeed", "square", "clover", "ebay"]
    entries = []

    for prov in providers:
        # Last run
        last_run = (
            db.query(ProviderSyncRun)
            .filter(
                ProviderSyncRun.user_id == current_user.id,
                ProviderSyncRun.provider == prov,
            )
            .order_by(ProviderSyncRun.started_at.desc())
            .first()
        )

        # Failed runs in the past 24 hours
        failed_24h = db.execute(
            text(
                "SELECT COUNT(*) FROM provider_sync_runs "
                "WHERE user_id = :uid AND provider = :prov "
                "  AND status = 'failed' "
                "  AND started_at >= now() - interval '24 hours'"
            ),
            {"uid": str(current_user.id), "prov": prov},
        ).scalar() or 0

        # Open reconciliation issues
        open_count = (
            db.query(func.count(ReconciliationIssue.id))
            .filter(
                ReconciliationIssue.user_id == current_user.id,
                ReconciliationIssue.provider == prov,
                ReconciliationIssue.status == "open",
            )
            .scalar()
            or 0
        )

        entries.append(
            ProviderHealthEntry(
                provider=prov,
                last_run_at=last_run.started_at if last_run else None,
                last_run_status=last_run.status if last_run else None,
                failed_runs_24h=int(failed_24h),
                open_issues_count=int(open_count),
            )
        )

    return ProviderHealthResponse(providers=entries)
