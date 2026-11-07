"""Google Sheets sync endpoints under /integrations/google/…"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Literal, Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.provider_outbox import ProviderOutbox
from app.models.user import User
from app.services.google_sheets import (
    NATIVE_RETURN,
    PROVIDER,
    GoogleApiError,
    google_sheets_service,
    web_return_origin,
)
from app.services.outbox import process_outbox

router = APIRouter(prefix="/integrations/google", tags=["integrations", "google_sheets"])


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
    return AuthUrlOut(authorization_url=google_sheets_service.authorization_url(current_user.id, platform))


def _web_return(result: str) -> HTMLResponse:
    """Popup flow: tell the opener and close; a full-page flow lands on Settings."""
    origin = web_return_origin()
    fallback = f"{settings.GOOGLE_WEB_RETURN_URL}?{urlencode({'integration': PROVIDER, 'status': result})}"
    message = {"type": "resqlo-oauth", "provider": PROVIDER, "status": result}
    html = (
        "<!doctype html><meta charset='utf-8'><title>Resqlo</title>"
        "<p>Google Sheets connection finished. You can close this window.</p><script>"
        f"var m={json.dumps(message)},o={json.dumps(origin)},f={json.dumps(fallback)};"
        "if(window.opener&&!window.opener.closed){try{window.opener.postMessage(m,o);}catch(e){}window.close();}"
        "setTimeout(function(){location.replace(f);},300);</script>"
    )
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


def _return(platform: str, result: str):
    if platform == "web":
        return _web_return(result)
    return RedirectResponse(NATIVE_RETURN.format(status=result), status_code=status.HTTP_303_SEE_OTHER)


@router.get("/callback")
async def google_callback(
    state: str,
    code: Optional[str] = None,
    error: Optional[str] = None,
    db: Session = Depends(get_db),
):
    parsed = google_sheets_service.parse_state(state)
    if error or not code:
        return _return(parsed["platform"], "denied")
    try:
        payload = await google_sheets_service.exchange_code(code, parsed["verifier"])
    except HTTPException:
        return _return(parsed["platform"], "error")
    google_sheets_service.upsert_token(db, parsed["user_id"], payload)
    return _return(parsed["platform"], "connected")


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
