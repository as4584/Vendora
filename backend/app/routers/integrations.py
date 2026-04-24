"""3rd-party integrations (Lightspeed, Square, etc.)."""
import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.inventory import InventoryExternalLink
from app.models.provider import ProviderSyncRun, ReconciliationIssue, ProviderWebhookEvent
from app.models.square import SquareCredential
from app.models.user import User
from app.schemas.integration import (
    LightspeedAuthURLResponse,
    LightspeedConnectResponse,
    LightspeedSyncResponse,
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
)
from app.services.lightspeed import lightspeed_service
from app.services.square import square_service
from app.services.clover import clover_service
from app.services.providers.base import record_webhook_event, is_duplicate_event

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
    """Return the OAuth URL so the reseller can authorize Vendora."""
    state = lightspeed_service.build_state(current_user.id)
    return LightspeedAuthURLResponse(authorization_url=lightspeed_service.authorization_url(state))


@router.get("/lightspeed/callback", response_model=LightspeedConnectResponse)
async def lightspeed_callback(code: str, state: str, db: Session = Depends(get_db)):
    """Handle Lightspeed OAuth callback and persist tokens."""
    user_id = lightspeed_service.parse_state(state)
    token_payload = await lightspeed_service.exchange_authorization_code(code)
    account_id = str(token_payload.get("account_id"))
    if not account_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Lightspeed response missing account_id")

    lightspeed_service.upsert_token(
        db,
        user_id=user_id,
        account_id=account_id,
        access_token=token_payload["access_token"],
        refresh_token=token_payload.get("refresh_token", ""),
        expires_at=token_payload["expires_at"],
        scopes=token_payload.get("scope"),
    )
    return LightspeedConnectResponse(message="Lightspeed account connected.")


@router.post("/lightspeed/sync", response_model=LightspeedSyncResponse)
async def lightspeed_sync(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One-way sync: pull latest inventory and sales from Lightspeed into Vendora."""
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
    """One-way import: pull Square catalog + inventory counts into Vendora."""
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
    """One-way import: pull Clover items and stock into Vendora."""
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
    if signature_key:
        sig_header = request.headers.get("x-square-hmacsha256-signature", "")
        # Square computes HMAC-SHA256 of (notification_url + raw_body)
        url = str(request.url)
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

    # Idempotency — if we've seen this event_id before, return 200 immediately
    if event_id and is_duplicate_event(db, "square", event_id):
        return {"status": "duplicate", "event_id": event_id}

    # Resolve user from merchant_id
    user_id: Optional[uuid.UUID] = None
    if merchant_id:
        cred = db.query(SquareCredential).filter_by(merchant_id=merchant_id).first()
        if cred:
            user_id = cred.user_id

    # Record the event (idempotent)
    if event_id:
        evt = record_webhook_event(
            db,
            provider="square",
            event_id=event_id,
            event_type=event_type,
            raw_payload=body_str,
            user_id=user_id,
        )
        db.commit()
    else:
        evt = None

    # Only act on supported event types when we can resolve a user
    actionable = {"inventory.count.updated", "catalog.version.updated"}
    if event_type in actionable and user_id:
        try:
            result = await square_service.sync(
                db,
                user_id,
                trigger_type="webhook",
                triggered_by_event_id=evt.id if evt else None,
            )
            if evt:
                evt.processed = True
                evt.sync_run_id = result.run_id
                db.add(evt)
                db.commit()
        except Exception as exc:
            if evt:
                evt.error = str(exc)[:2000]
                db.add(evt)
                db.commit()
            # Return 200 — Square re-delivers on non-2xx; we've already logged it
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
    providers = ["lightspeed", "square", "clover"]
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
