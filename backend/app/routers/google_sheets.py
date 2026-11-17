"""Google Sheets sync endpoints under /integrations/google/…"""
from __future__ import annotations

import html
import uuid
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.provider_outbox import ProviderOutbox
from app.models.user import User
from app.services.google_sheets import (
    NATIVE_RETURN,
    PROVIDER,
    GoogleApiError,
    google_sheets_service,
)
from app.services import google_picker
from app.services.oauth_return import finish_response, return_target_for
from app.services.outbox import process_outbox

router = APIRouter(prefix="/integrations/google", tags=["integrations", "google_sheets"])

# Picker tickets are signed JWTs: three URL-safe base64 segments.
_TICKET_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.")


def _ticket_shape_ok(ticket: str) -> bool:
    return 0 < len(ticket) <= 4096 and ticket.count(".") == 2 and set(ticket) <= _TICKET_CHARS


class LinkOut(BaseModel):
    spreadsheet_id: str
    title: Optional[str] = None
    url: Optional[str] = None
    tab: str
    source_of_truth: bool
    archive_missing: bool
    last_synced_at: Optional[datetime] = None
    last_error: Optional[str] = None
    mapped_columns: list[str] = []


class StatusOut(BaseModel):
    configured: bool
    # Seller can pick one of their own existing sheets (Google Picker).
    picker_available: bool = False
    connected: bool
    email: Optional[str] = None
    sheet: Optional[LinkOut] = None
    pending_pushes: int = 0
    failed_pushes: int = 0


class AuthUrlOut(BaseModel):
    authorization_url: str


class CreateIn(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)


class LinkIn(BaseModel):
    url: str = Field(min_length=10, max_length=2048)
    tab: Optional[str] = Field(default=None, max_length=255)


class SettingsIn(BaseModel):
    source_of_truth: Optional[bool] = None
    archive_missing: Optional[bool] = None


class PickerUrlOut(BaseModel):
    picker_url: str


class PickedIn(BaseModel):
    ticket: str = Field(min_length=20, max_length=4096)
    spreadsheet_id: str = Field(min_length=10, max_length=200, pattern=r"^[A-Za-z0-9_-]+$")


class SyncOut(BaseModel):
    run_id: Optional[uuid.UUID] = None
    created: int = 0
    updated: int = 0
    archived: int = 0
    appended: int = 0
    conflicts: int = 0
    note: Optional[str] = None
    pushes_processed: int = 0


def _api_error(exc: GoogleApiError) -> HTTPException:
    code = status.HTTP_429_TOO_MANY_REQUESTS if exc.status_code == 429 else status.HTTP_502_BAD_GATEWAY
    return HTTPException(code, detail=f"Google Sheets error: {exc.message}")


def _link_out(link) -> Optional[LinkOut]:
    if link is None:
        return None
    return LinkOut(
        spreadsheet_id=link.spreadsheet_id, title=link.spreadsheet_title, url=link.spreadsheet_url,
        tab=link.sheet_tab, source_of_truth=link.source_of_truth, archive_missing=link.archive_missing,
        last_synced_at=link.last_synced_at, last_error=link.last_error,
        mapped_columns=sorted((link.header_map or {}).keys()),
    )


def _status(db: Session, user: User) -> StatusOut:
    token = google_sheets_service.get_token(db, user.id)
    jobs = db.query(ProviderOutbox).filter(ProviderOutbox.user_id == user.id, ProviderOutbox.provider == PROVIDER)
    return StatusOut(
        configured=google_sheets_service.is_configured(),
        picker_available=google_picker.picker_configured(),
        connected=token is not None,
        email=token.email if token else None,
        sheet=_link_out(google_sheets_service.get_link(db, user.id)),
        pending_pushes=jobs.filter(ProviderOutbox.status == "pending").count(),
        failed_pushes=jobs.filter(ProviderOutbox.status == "failed").count(),
    )


@router.get("/status", response_model=StatusOut)
def google_status(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return _status(db, current_user)


@router.get("/connect", response_model=AuthUrlOut)
def google_connect(
    platform: Literal["web", "native"] = Query("native"),
    current_user: User = Depends(get_current_user),
):
    return AuthUrlOut(authorization_url=google_sheets_service.authorization_url(current_user.id, return_target_for(platform)))


def _return(state: str, result: str):
    return finish_response(PROVIDER, result, state, app_url=NATIVE_RETURN.format(status=result))


@router.get("/callback")
async def google_callback(
    state: str,
    code: Optional[str] = None,
    error: Optional[str] = None,
    db: Session = Depends(get_db),
):
    parsed = google_sheets_service.parse_state(state)
    if error or not code:
        return _return(state, "denied")
    try:
        payload = await google_sheets_service.exchange_code(code, parsed["verifier"])
    except HTTPException:
        return _return(state, "error")
    google_sheets_service.upsert_token(db, parsed["user_id"], payload)
    return _return(state, "connected")


@router.delete("")
async def google_disconnect(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    await google_sheets_service.disconnect(db, current_user.id)
    return {"disconnected": True}


@router.post("/sheet/create", response_model=StatusOut, status_code=status.HTTP_201_CREATED)
async def google_create_sheet(
    body: CreateIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    try:
        await google_sheets_service.create_sheet(db, current_user.id, body.title)
    except GoogleApiError as exc:
        raise _api_error(exc) from exc
    return _status(db, current_user)


@router.post("/sheet/link", response_model=StatusOut)
async def google_link_sheet(
    body: LinkIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    try:
        await google_sheets_service.link_existing(db, current_user.id, body.url, body.tab)
        await google_sheets_service.pull(db, current_user.id, trigger="manual")
    except GoogleApiError as exc:
        raise _api_error(exc) from exc
    return _status(db, current_user)


@router.get("/picker", response_model=PickerUrlOut)
def google_picker_url(
    platform: Literal["web", "native"] = Query("native"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One-off page URL where the seller picks one of their own sheets."""
    google_picker.ensure_configured()
    google_sheets_service.require_token(db, current_user.id)
    ticket = google_picker.make_ticket(current_user.id, return_target_for(platform))
    return PickerUrlOut(picker_url=f"{google_picker.public_url('picker/page')}?ticket={ticket}")


@router.get("/picker/page", name="google_picker_page", response_class=HTMLResponse)
async def google_picker_page(ticket: str, db: Session = Depends(get_db)):
    google_picker.ensure_configured()
    if not _ticket_shape_ok(ticket):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="This link expired. Open the picker again from Resqlo.")
    claims = google_picker.read_ticket(ticket)
    access = await google_picker.access_token_for(db, claims["user_id"])
    # A verified JWT is URL-safe base64; escaping is a no-op for it and a guard for anything else.
    page = google_picker.picker_page(
        html.escape(ticket), access, claims["ret"], google_picker.public_url("picker/link")
    )
    return HTMLResponse(page, headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY"})


@router.post("/picker/link", name="google_picker_link")
async def google_picker_link(body: PickedIn, db: Session = Depends(get_db)):
    """Called by the picker page: link the chosen sheet and pull it in."""
    claims = google_picker.read_ticket(body.ticket)
    try:
        await google_picker.link_picked(db, claims["user_id"], body.spreadsheet_id)
    except GoogleApiError as exc:
        raise _api_error(exc) from exc
    return {"linked": True}


@router.patch("/sheet", response_model=StatusOut)
def google_sheet_settings(
    body: SettingsIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    link = google_sheets_service.require_link(db, current_user.id)
    if body.source_of_truth is not None:
        link.source_of_truth = body.source_of_truth
    if body.archive_missing is not None:
        link.archive_missing = body.archive_missing
    db.commit()
    return _status(db, current_user)


@router.delete("/sheet", response_model=StatusOut)
def google_unlink_sheet(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    link = google_sheets_service.get_link(db, current_user.id)
    if link is not None:
        db.delete(link)
        db.query(ProviderOutbox).filter(
            ProviderOutbox.user_id == current_user.id, ProviderOutbox.provider == PROVIDER,
            ProviderOutbox.status == "pending",
        ).delete(synchronize_session=False)
        db.commit()
    return _status(db, current_user)


@router.post("/sync", response_model=SyncOut)
async def google_sync_now(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    google_sheets_service.require_token(db, current_user.id)
    try:
        run = await google_sheets_service.pull(db, current_user.id, trigger="manual")
    except GoogleApiError as exc:
        raise _api_error(exc) from exc
    processed = await process_outbox(db, user_id=current_user.id, provider=PROVIDER)
    meta = (run.metadata_ or {}) if run else {}
    return SyncOut(
        run_id=run.id if run else None,
        created=run.items_imported if run else 0,
        updated=run.items_updated if run else 0,
        archived=meta.get("archived", 0),
        appended=meta.get("appended", 0),
        conflicts=len(meta.get("conflicts") or []),
        note=meta.get("note"),
        pushes_processed=processed,
    )
