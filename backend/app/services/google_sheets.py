"""Google Sheets as the source of truth for inventory.

OAuth   authorization code + PKCE (S256) with scopes ``drive.file openid email``.
        ``drive.file`` only reaches files Resqlo created (or the seller opened
        with Resqlo), so it avoids Google's restricted-scope review.
Link    one spreadsheet tab per user (GoogleSheetLink). Either created by Resqlo
        with the canonical export columns, or an existing sheet the token can
        open; its header row is mapped with the import alias logic.
Pull    (every ~60s from the outbox sweep, and "Sync now") reads the tab and
        applies it over the app — the SHEET WINS. Rows without an id become
        new items and get their id written back; rows removed from the sheet
        archive their item (opt-in) or are flagged for review.
Push    every app-side change enqueues a ``google_sheets/push_row`` job in the
        shared provider outbox that rewrites only that item's changed cells.
        A push never overwrites a row the seller edited since the last sync.

All writes use ``valueInputOption=RAW`` (Sheets never evaluates them) and
``safe_cell`` text, so Resqlo never writes a formula.

HTTP goes through ``self.transport`` (None in production) so tests inject an
``httpx.MockTransport``; ``self.sleep`` is injectable for 429 backoff tests.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote, urlencode, urlparse

import httpx
import jwt
from fastapi import HTTPException, status
from jwt.exceptions import InvalidTokenError as JWTError
from sqlalchemy.orm import Session

from app.config import settings
from app.models.google_sheets import GoogleSheetLink, GoogleToken
from app.models.inventory import InventoryItem, InventoryStockLedger
from app.models.provider import ProviderSyncRun, ReconciliationIssue
from app.models.provider_outbox import ProviderOutbox
from app.security.token_encryption import decrypt_token, encrypt_token
from app.services.csv_export import INVENTORY_EXPORT_COLUMNS, safe_cell
from app.services.spreadsheet_import import (
    normalize_header,
    parse_money,
    parse_quantity,
    parse_status,
    resolve_field,
    unescape_cell,
)

logger = logging.getLogger(__name__)

PROVIDER = "google_sheets"
PUSH_ROW = "push_row"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
SCOPES = "https://www.googleapis.com/auth/drive.file openid email"
DEFAULT_TITLE = "Resqlo Inventory"
DEFAULT_TAB = "Inventory"
MAX_429_RETRIES = 3
NATIVE_RETURN = "vendora://settings?integration=google_sheets&status={status}"

NOT_CONFIGURED = "Google Sheets not configured"
NOT_CONNECTED = "Google not connected"
NOT_LINKED = "No Google Sheet linked"

MONEY_FIELDS = ("buy_price", "expected_sell_price", "actual_sell_price")
TEXT_FIELDS = (
    "name", "category", "sku", "upc", "size", "color", "condition",
    "platform", "vendor_name", "notes", "photo_front_url", "photo_back_url",
)
# Fields kept in sync, in canonical column order.
SYNC_FIELDS = tuple(c for c in INVENTORY_EXPORT_COLUMNS if c in MONEY_FIELDS + TEXT_FIELDS + ("quantity", "status"))
FIELD_LIMITS = {
    "name": 255, "category": 100, "sku": 100, "upc": 50, "size": 50, "color": 50,
    "condition": 50, "platform": 100, "vendor_name": 255,
}
ID = "id"


class GoogleApiError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message

    @property
    def retryable(self) -> bool:
        return self.status_code in (401, 408, 429, 500, 502, 503, 504)


# ── pure helpers ─────────────────────────────────────────────────────────────

def column_letter(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA."""
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def a1(tab: str, ref: str = "") -> str:
    quoted = "'" + tab.replace("'", "''") + "'"
    return f"{quoted}!{ref}" if ref else quoted


def spreadsheet_id_from_url(value: str) -> Optional[str]:
    text = (value or "").strip()
    match = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]{20,})", text)
    if match:
        return match.group(1)
    if re.fullmatch(r"[a-zA-Z0-9_-]{20,}", text):
        return text
    return None


def gid_from_url(value: str) -> Optional[int]:
    match = re.search(r"[#&?]gid=(\d+)", value or "")
    return int(match.group(1)) if match else None


def map_headers(header: list[Any]) -> dict[str, int]:
    """Canonical field (and "id") -> 0-based column. Exact names beat aliases."""
    exact = {normalize_header(f): f for f in SYNC_FIELDS}
    mapping: dict[str, int] = {}
    priority: dict[str, int] = {}
    for col, raw in enumerate(header):
        norm = normalize_header(raw)
        if not norm or "formula" in norm:
            continue
        if norm == ID:
            mapping.setdefault(ID, col)
            continue
        if norm in ("externalid", "createdat", "updatedat", "sizebreakdown"):
            continue
        if norm in exact:
            field, prio = exact[norm], 0
        else:
            field, prio = resolve_field(raw), 1
        if field not in SYNC_FIELDS:
            continue
        if field in mapping and priority[field] <= prio:
            continue
        mapping[field] = col
        priority[field] = prio
    return mapping


def _text(value: Any) -> str:
    return str(unescape_cell(value) if value is not None else "").strip()


def normalize_sheet(field: str, value: Any) -> Optional[str]:
    """A sheet cell -> canonical comparison string (None = no opinion)."""
    raw = _text(value)
    if field in MONEY_FIELDS:
        return parse_money(raw)[0] or ""
    if field == "quantity":
        return str(parse_quantity(raw)[0]) if raw else "0"
    if field == "status":
        return parse_status(raw)[0] if raw else None
    if field == "name" and not raw:
        return None
    return raw[: FIELD_LIMITS[field]] if field in FIELD_LIMITS else raw


def normalize_app(item: InventoryItem, field: str) -> str:
    value = getattr(item, field, None)
    if value is None:
        return ""
    if field in MONEY_FIELDS:
        return f"{Decimal(str(value)).quantize(Decimal('0.01'))}"
    return str(value).strip()


def sheet_values(row: list[Any], header_map: dict[str, int]) -> dict[str, str]:
    out: dict[str, str] = {}
    for field, col in header_map.items():
        if field == ID:
            continue
        norm = normalize_sheet(field, row[col] if col < len(row) else "")
        if norm is not None:
            out[field] = norm
    return out


def app_values(item: InventoryItem, fields) -> dict[str, str]:
    return {f: normalize_app(item, f) for f in fields if f != ID}


def cell_value(item: InventoryItem, field: str) -> Any:
    """What Resqlo writes into a cell: numbers as numbers, text made literal."""
    if field == ID:
        return str(item.id)
    value = getattr(item, field, None)
    if value is None:
        return ""
    if field in MONEY_FIELDS:
        return float(value)
    if field == "quantity":
        return int(value)
    return safe_cell(str(value))


def row_cells(item: InventoryItem, header_map: dict[str, int]) -> list[Any]:
    width = max(header_map.values()) + 1 if header_map else 0
    row: list[Any] = [""] * width
    for field, col in header_map.items():
        row[col] = cell_value(item, field)
    return row


def values_hash(values: list[list[Any]]) -> str:
    return hashlib.sha256(json.dumps(values, default=str).encode()).hexdigest()


def _is_blank(row: list[Any]) -> bool:
    return not any(_text(c) for c in row)


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


# ── service ──────────────────────────────────────────────────────────────────

class GoogleSheetsService:
    def __init__(self) -> None:
        self.transport: Optional[httpx.AsyncBaseTransport] = None
        self.sleep: Callable[[float], Awaitable[None]] = asyncio.sleep

    def is_configured(self) -> bool:
        return bool(settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET and settings.GOOGLE_REDIRECT_URI)

    def assert_configured(self) -> None:
        if not self.is_configured():
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=NOT_CONFIGURED)

    def _client(self, timeout: float = 30) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=timeout, transport=self.transport)

    # ── OAuth ──────────────────────────────────────────────────────────────

    def build_state(self, user_id: uuid.UUID, platform: str, verifier: str) -> str:
        payload = {
            "sub": str(user_id),
            "purpose": "google_oauth",
            "ret": "web" if platform == "web" else "native",
            # The PKCE verifier travels encrypted: the browser only sees ciphertext.
            "cv": encrypt_token(verifier),
            "nonce": secrets.token_urlsafe(12),
            "exp": datetime.now(timezone.utc) + timedelta(minutes=10),
        }
        return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

    def parse_state(self, state: str) -> dict:
        try:
            payload = jwt.decode(state, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            if payload.get("purpose") != "google_oauth":
                raise ValueError("invalid state purpose")
            return {
                "user_id": uuid.UUID(payload["sub"]),
                "platform": payload.get("ret", "native"),
                "verifier": decrypt_token(payload["cv"]),
            }
        except (JWTError, KeyError, TypeError, ValueError) as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid Google state parameter") from exc

    def authorization_url(self, user_id: uuid.UUID, platform: str = "native") -> str:
        self.assert_configured()
        verifier, challenge = _pkce_pair()
        params = urlencode({
            "response_type": "code",
            "client_id": settings.GOOGLE_CLIENT_ID,
            "redirect_uri": settings.GOOGLE_REDIRECT_URI,
            "scope": SCOPES,
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": self.build_state(user_id, platform, verifier),
        })
        return f"{AUTH_URL}?{params}"

    async def _token_request(self, data: dict) -> dict:
        self.assert_configured()
        async with self._client() as client:
            resp = await client.post(TOKEN_URL, data={
                **data,
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
            })
        if resp.status_code >= 400:
            logger.error("Google token request failed %s", resp.status_code)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail="Google token request failed")
        payload = resp.json()
        payload["expires_at"] = datetime.now(timezone.utc) + timedelta(seconds=int(payload.get("expires_in", 3600)))
        return payload

    async def exchange_code(self, code: str, verifier: str) -> dict:
        payload = await self._token_request({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": settings.GOOGLE_REDIRECT_URI,
            "code_verifier": verifier,
        })
        try:
            async with self._client(10) as client:
                info = await client.get(USERINFO_URL, headers={"Authorization": f"Bearer {payload['access_token']}"})
            payload["email"] = info.json().get("email") if info.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            payload["email"] = None
        return payload

    def get_token(self, db: Session, user_id: uuid.UUID) -> Optional[GoogleToken]:
        return db.query(GoogleToken).filter(GoogleToken.user_id == user_id).one_or_none()

    def upsert_token(self, db: Session, user_id: uuid.UUID, payload: dict) -> GoogleToken:
        token = self.get_token(db, user_id) or GoogleToken(user_id=user_id)
        token.access_token = encrypt_token(payload["access_token"])
        if payload.get("refresh_token") or not token.refresh_token:
            token.refresh_token = encrypt_token(payload.get("refresh_token") or "")
        token.expires_at = payload["expires_at"]
        token.scopes = payload.get("scope")
        token.email = payload.get("email") or token.email
        db.add(token)
        db.commit()
        db.refresh(token)
        return token

    async def refresh(self, db: Session, token: GoogleToken) -> GoogleToken:
        refresh_token = decrypt_token(token.refresh_token)
        if not refresh_token:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Google session expired, please reconnect.")
        try:
            payload = await self._token_request({"grant_type": "refresh_token", "refresh_token": refresh_token})
        except HTTPException as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Google session expired, please reconnect.") from exc
        token.access_token = encrypt_token(payload["access_token"])
        token.expires_at = payload["expires_at"]
        if payload.get("refresh_token"):
            token.refresh_token = encrypt_token(payload["refresh_token"])
        db.add(token)
        db.flush()
        return token

    def require_token(self, db: Session, user_id: uuid.UUID) -> GoogleToken:
        self.assert_configured()
        token = self.get_token(db, user_id)
        if token is None:
            raise HTTPException(status.HTTP_409_CONFLICT, detail=NOT_CONNECTED)
        return token

    async def disconnect(self, db: Session, user_id: uuid.UUID) -> None:
        token = self.get_token(db, user_id)
        if token is not None:
            try:
                async with self._client(10) as client:
                    await client.post(REVOKE_URL, data={"token": decrypt_token(token.refresh_token) or decrypt_token(token.access_token)})
            except httpx.HTTPError:
                logger.warning("Google token revoke failed; deleting locally anyway")
            db.delete(token)
        link = self.get_link(db, user_id)
        if link is not None:
            db.delete(link)
        (
            db.query(ProviderOutbox)
            .filter(ProviderOutbox.user_id == user_id, ProviderOutbox.provider == PROVIDER, ProviderOutbox.status == "pending")
            .delete(synchronize_session=False)
        )
        db.commit()

    # ── HTTP ───────────────────────────────────────────────────────────────

    async def request(self, db: Session, user_id: uuid.UUID, method: str, url: str, *,
                      params: Optional[dict] = None, json_body: Optional[dict] = None) -> Any:
        """Authenticated Google call: refresh near expiry and once on 401; back
        off on 429 (Retry-After or exponential) up to MAX_429_RETRIES."""
        token = self.require_token(db, user_id)
        expires = token.expires_at if token.expires_at.tzinfo else token.expires_at.replace(tzinfo=timezone.utc)
        if expires - datetime.now(timezone.utc) < timedelta(minutes=2):
            token = await self.refresh(db, token)
        refreshed = False
        attempt = 0
        while True:
            headers = {"Authorization": f"Bearer {decrypt_token(token.access_token)}", "Accept": "application/json"}
            async with self._client() as client:
                resp = await client.request(method, url, headers=headers, params=params, json=json_body)
            if resp.status_code == 429 and attempt < MAX_429_RETRIES:
                retry_after = resp.headers.get("Retry-After")
                try:
                    delay = min(float(retry_after), 60.0) if retry_after else 2.0 ** attempt
                except ValueError:
                    delay = 2.0 ** attempt
                attempt += 1
                logger.warning("Google Sheets rate limited; retry %d in %.1fs", attempt, delay)
                await self.sleep(delay)
                continue
            if resp.status_code == 401 and not refreshed:
                refreshed = True
                token = await self.refresh(db, token)
                continue
            if resp.status_code >= 400:
                try:
                    message = resp.json().get("error", {}).get("message") or resp.text
                except ValueError:
                    message = resp.text
                raise GoogleApiError(resp.status_code, (str(message or "").strip() or f"HTTP {resp.status_code}")[:500])
            return resp.json() if resp.content else {}

    async def _get_values(self, db: Session, link: GoogleSheetLink) -> list[list[Any]]:
        data = await self.request(
            db, link.user_id, "GET", f"{SHEETS_API}/{link.spreadsheet_id}/values/{quote(a1(link.sheet_tab), safe='')}",
            params={"valueRenderOption": "FORMATTED_VALUE", "majorDimension": "ROWS"},
        )
        return [list(r) for r in (data.get("values") or [])]

    async def _write_cells(self, db: Session, link: GoogleSheetLink, data: list[dict]) -> None:
        if not data:
            return
        await self.request(
            db, link.user_id, "POST", f"{SHEETS_API}/{link.spreadsheet_id}/values:batchUpdate",
            json_body={"valueInputOption": "RAW", "data": data},
        )

    async def _append_rows(self, db: Session, link: GoogleSheetLink, rows: list[list[Any]]) -> None:
        if not rows:
            return
        await self.request(
            db, link.user_id, "POST",
            f"{SHEETS_API}/{link.spreadsheet_id}/values/{quote(a1(link.sheet_tab, 'A1'), safe='')}:append",
            params={"valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"},
            json_body={"values": rows},
        )

    # ── linking ────────────────────────────────────────────────────────────

    def get_link(self, db: Session, user_id: uuid.UUID) -> Optional[GoogleSheetLink]:
        return db.query(GoogleSheetLink).filter(GoogleSheetLink.user_id == user_id).one_or_none()

    def require_link(self, db: Session, user_id: uuid.UUID) -> GoogleSheetLink:
        link = self.get_link(db, user_id)
        if link is None:
            raise HTTPException(status.HTTP_409_CONFLICT, detail=NOT_LINKED)
        return link

    def _active_items(self, db: Session, user_id: uuid.UUID) -> list[InventoryItem]:
        return (
            db.query(InventoryItem)
            .filter(InventoryItem.user_id == user_id, InventoryItem.deleted_at.is_(None), InventoryItem.status != "archived")
            .order_by(InventoryItem.created_at)
            .all()
        )

    def _save_link(self, db: Session, user_id: uuid.UUID, **fields) -> GoogleSheetLink:
        link = self.get_link(db, user_id) or GoogleSheetLink(user_id=user_id)
        for key, value in fields.items():
            setattr(link, key, value)
        db.add(link)
        db.flush()
        return link

    async def create_sheet(self, db: Session, user_id: uuid.UUID, title: Optional[str] = None) -> GoogleSheetLink:
        """Create a spreadsheet with the canonical columns (header frozen) and current inventory."""
        self.require_token(db, user_id)
        created = await self.request(db, user_id, "POST", SHEETS_API, json_body={
            "properties": {"title": (title or DEFAULT_TITLE)[:200]},
            "sheets": [{"properties": {"title": DEFAULT_TAB, "gridProperties": {"frozenRowCount": 1}}}],
        })
        sheet_props = ((created.get("sheets") or [{}])[0]).get("properties") or {}
        header = list(INVENTORY_EXPORT_COLUMNS)
        header_map = map_headers(header)
        items = self._active_items(db, user_id)
        link = self._save_link(
            db, user_id,
            spreadsheet_id=created["spreadsheetId"],
            spreadsheet_title=(created.get("properties") or {}).get("title") or DEFAULT_TITLE,
            spreadsheet_url=created.get("spreadsheetUrl"),
            sheet_tab=sheet_props.get("title") or DEFAULT_TAB,
            sheet_gid=sheet_props.get("sheetId"),
            header_map=header_map,
            row_state={},
            last_values_hash=None,
            last_error=None,
        )
        rows = [header] + [row_cells(i, header_map) for i in items]
        await self._write_cells(db, link, [{"range": a1(link.sheet_tab, "A1"), "values": rows}])
        link.row_state = {str(i.id): app_values(i, header_map) for i in items}
        link.last_synced_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(link)
        return link

    async def link_existing(self, db: Session, user_id: uuid.UUID, url: str, tab: Optional[str] = None) -> GoogleSheetLink:
        """Link a sheet the token can open (drive.file: one Resqlo created or the
        seller picked with Resqlo). Maps its header row; adds an id column."""
        self.require_token(db, user_id)
        spreadsheet_id = spreadsheet_id_from_url(url)
        if not spreadsheet_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="That is not a Google Sheets link.")
        try:
            meta = await self.request(
                db, user_id, "GET", f"{SHEETS_API}/{spreadsheet_id}",
                params={"fields": "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties"},
            )
        except GoogleApiError as exc:
            if exc.status_code in (403, 404):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=(
                        "Resqlo can't open that sheet. Google only lets Resqlo reach sheets it created "
                        "or that you picked with Resqlo. Create a Resqlo sheet instead, or import this "
                        "one first and then create a Resqlo sheet."
                    ),
                ) from exc
            raise
        sheets = [s.get("properties") or {} for s in meta.get("sheets") or []]
        wanted_gid = gid_from_url(url)
        props = next((p for p in sheets if tab and p.get("title") == tab), None) \
            or next((p for p in sheets if wanted_gid is not None and p.get("sheetId") == wanted_gid), None) \
            or (sheets[0] if sheets else {"title": DEFAULT_TAB})
        link = self._save_link(
            db, user_id,
            spreadsheet_id=spreadsheet_id,
            spreadsheet_title=(meta.get("properties") or {}).get("title"),
            spreadsheet_url=meta.get("spreadsheetUrl") or f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit",
            sheet_tab=props.get("title") or DEFAULT_TAB,
            sheet_gid=props.get("sheetId"),
            header_map={},
            row_state={},
            last_values_hash=None,
            last_error=None,
        )
        values = await self._get_values(db, link)
        header = values[0] if values else []
        header_map = map_headers(header)
        if "name" not in header_map and not header_map.get("sku") and not header_map.get("upc"):
            db.rollback()
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Couldn't find an item name column in the first row of that tab.",
            )
        link.header_map = await self._ensure_id_column(db, link, header, header_map)
        db.commit()
        db.refresh(link)
        return link

    async def _ensure_id_column(self, db: Session, link: GoogleSheetLink, header: list[Any], header_map: dict) -> dict:
        if ID in header_map:
            return header_map
        col = len(header)
        await self._write_cells(db, link, [{"range": a1(link.sheet_tab, f"{column_letter(col)}1"), "values": [[ID]]}])
        return {**header_map, ID: col}

    # ── pull (sheet -> app; sheet wins) ────────────────────────────────────

    def _apply(self, db: Session, item: InventoryItem, values: dict[str, str]) -> None:
        old_qty = int(item.quantity or 0)
        for field, value in values.items():
            if field in MONEY_FIELDS:
                setattr(item, field, Decimal(value) if value else None)
            elif field == "quantity":
                item.quantity = int(value)
            else:
                setattr(item, field, value or None)
        new_qty = int(item.quantity or 0)
        if "status" not in values:
            if new_qty == 0 and item.status in ("in_stock", "listed"):
                item.status = "sold"
            elif new_qty > 0 and item.status == "sold":
                item.status = "in_stock"
        if item.id is not None and new_qty != old_qty:
            db.add(InventoryStockLedger(
                inventory_item_id=item.id, user_id=item.user_id,
                delta_quantity=new_qty - old_qty, quantity_after=new_qty,
                event_type="sync", source_type=PROVIDER, source_id=str(item.id),
            ))
            from app.services.outbox import enqueue_stock_change

            enqueue_stock_change(db, item, source_type=PROVIDER)

    def _find_item(self, db: Session, user_id: uuid.UUID, row_id: str, values: dict, claimed: set) -> Optional[InventoryItem]:
        base = db.query(InventoryItem).filter(InventoryItem.user_id == user_id, InventoryItem.deleted_at.is_(None))
        if row_id:
            try:
                parsed = uuid.UUID(row_id)
            except ValueError:
                parsed = None
            if parsed is not None and parsed not in claimed:
                match = base.filter(InventoryItem.id == parsed).first()
                if match:
                    return match
        for field in ("upc", "sku"):
            if values.get(field):
                match = base.filter(getattr(InventoryItem, field) == values[field]).first()
                if match and match.id not in claimed:
                    return match
        return None

    async def pull(self, db: Session, user_id: uuid.UUID, trigger: str = "manual") -> Optional[ProviderSyncRun]:
        """Apply the sheet over the app. Returns the sync run (None = nothing changed on a periodic run)."""
        link = self.require_link(db, user_id)
        started = datetime.now(timezone.utc)
        try:
            values = await self._get_values(db, link)
            run = await self._pull_values(db, link, values, trigger, started)
        except Exception as exc:  # noqa: BLE001 - recorded on the link + a failed run
            db.rollback()
            link = self.require_link(db, user_id)
            message = getattr(exc, "detail", None) or getattr(exc, "message", None) or str(exc) or exc.__class__.__name__
            message = str(message)[:1000]
            changed = link.last_error != message
            link.last_error = message
            run = None
            if changed or trigger != "periodic":
                run = ProviderSyncRun(
                    provider=PROVIDER, user_id=user_id, account_id=link.spreadsheet_id, started_at=started,
                    completed_at=datetime.now(timezone.utc), status="failed", errors_count=1,
                    error_message=message, trigger_type="scheduled" if trigger == "periodic" else trigger,
                )
                db.add(run)
            db.commit()
            if trigger != "periodic":
                raise
            return run
        return run

    async def _pull_values(self, db: Session, link: GoogleSheetLink, values: list[list[Any]],
                           trigger: str, started: datetime) -> Optional[ProviderSyncRun]:
        user_id = link.user_id
        header = values[0] if values else []
        header_map = map_headers(header)
        if not header_map or ("name" not in header_map and "sku" not in header_map and "upc" not in header_map):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="The sheet's header row is missing.")
        header_map = await self._ensure_id_column(db, link, header, header_map)
        state: dict[str, dict] = dict(link.row_state or {})
        new_hash = values_hash(values)
        unsynced = [i for i in self._active_items(db, user_id) if str(i.id) not in state]
        if trigger == "periodic" and new_hash == link.last_values_hash and not unsynced and header_map == link.header_map:
            link.last_synced_at = datetime.now(timezone.utc)
            link.last_error = None
            db.commit()
            return None

        id_col = header_map[ID]
        fields = [f for f in header_map if f != ID]
        apply_sheet = bool(link.source_of_truth)
        writes: list[dict] = []
        seen: set[uuid.UUID] = set()
        created = updated = archived = flagged = errors = 0
        conflicts: list[dict] = []

        for offset, row in enumerate(values[1:]):
            row_number = offset + 2
            if _is_blank(row):
                continue
            sv = sheet_values(row, header_map)
            row_id = _text(row[id_col]) if id_col < len(row) else ""
            if not sv.get("name") and not sv.get("sku") and not sv.get("upc"):
                continue
            item = self._find_item(db, user_id, row_id, sv, seen)
            if item is None:
                if not apply_sheet:
                    continue
                if not sv.get("name"):
                    errors += 1
                    continue
                item = InventoryItem(user_id=user_id, source=PROVIDER, custom_attributes={}, quantity=1, status="in_stock")
                self._apply(db, item, sv)
                db.add(item)
                db.flush()
                created += 1
                seen.add(item.id)
                state[str(item.id)] = app_values(item, fields)
                writes.append({"range": a1(link.sheet_tab, f"{column_letter(id_col)}{row_number}"), "values": [[str(item.id)]]})
                continue
            seen.add(item.id)
            if row_id != str(item.id):
                writes.append({"range": a1(link.sheet_tab, f"{column_letter(id_col)}{row_number}"), "values": [[str(item.id)]]})
            snap = state.get(str(item.id))
            app = app_values(item, sv.keys())
            sheet_changed = snap is None or any(sv[f] != snap.get(f) for f in sv)
            app_changed = snap is not None and any(app[f] != snap.get(f) for f in sv)
            if sheet_changed and apply_sheet:
                diffs = {f: sv[f] for f in sv if sv[f] != app[f]}
                if diffs:
                    if app_changed:
                        lost = {f: {"app": app[f], "sheet": sv[f]} for f in diffs if snap and app[f] != snap.get(f)}
                        if lost:
                            conflicts.append({"item_id": str(item.id), "name": item.name, "fields": lost})
                    self._apply(db, item, diffs)
                    db.add(item)
                    updated += 1
                state[str(item.id)] = sv | {f: v for f, v in app_values(item, fields).items() if f not in sv}
            elif app_changed or (sheet_changed and not apply_sheet):
                enqueue_sheet_push(db, item, force=True)
                if snap is None:
                    state[str(item.id)] = sv
            else:
                state[str(item.id)] = snap

        # Rows removed from the sheet since the last sync.
        for item_id in list(state):
            try:
                parsed = uuid.UUID(item_id)
            except ValueError:
                state.pop(item_id)
                continue
            if parsed in seen:
                continue
            item = db.query(InventoryItem).filter(InventoryItem.id == parsed, InventoryItem.user_id == user_id).first()
            if item is None or item.deleted_at is not None or item.status == "archived":
                state.pop(item_id)
                continue
            if not apply_sheet:
                enqueue_sheet_push(db, item, force=True)
                state.pop(item_id)
                continue
            if link.archive_missing:
                item.status = "archived"
                db.add(item)
                archived += 1
                state.pop(item_id)
            elif not self._open_issue(db, user_id, item.id, "missing_item"):
                db.add(ReconciliationIssue(
                    provider=PROVIDER, user_id=user_id, inventory_item_id=item.id, external_id=item_id,
                    issue_type="missing_item", severity="warning",
                    details={"message": f"{item.name} was removed from the Google Sheet. Archive it, or add the row back."},
                ))
                flagged += 1

        # App items the sheet has never seen (e.g. added while a push was failing).
        append_items = [i for i in self._active_items(db, user_id) if str(i.id) not in state and i.id not in seen]
        if writes:
            await self._write_cells(db, link, writes)
        if append_items:
            await self._append_rows(db, link, [row_cells(i, header_map) for i in append_items])
            for item in append_items:
                state[str(item.id)] = app_values(item, fields)

        now = datetime.now(timezone.utc)
        link.header_map = header_map
        link.row_state = state
        # Our own writes change the sheet; re-read next time instead of trusting this hash.
        link.last_values_hash = None if (writes or append_items) else new_hash
        link.last_synced_at = now
        link.last_error = None
        db.add(link)

        changed = created or updated or archived or flagged or conflicts or errors or append_items
        if not changed and trigger == "periodic":
            db.commit()
            return None
        run = ProviderSyncRun(
            provider=PROVIDER, user_id=user_id, account_id=link.spreadsheet_id, started_at=started, completed_at=now,
            status="partial" if errors else "completed", items_imported=created, items_updated=updated,
            items_skipped=errors, errors_count=errors,
            trigger_type="scheduled" if trigger == "periodic" else trigger,
            metadata_={
                "trigger": trigger, "archived": archived, "flagged_missing": flagged,
                "appended": len(append_items), "conflicts": conflicts,
                "note": _conflict_note(conflicts),
            },
        )
        db.add(run)
        db.flush()
        for conflict in conflicts:
            db.add(ReconciliationIssue(
                provider=PROVIDER, user_id=user_id, inventory_item_id=uuid.UUID(conflict["item_id"]),
                sync_run_id=run.id, external_id=conflict["item_id"], issue_type="unknown", severity="info",
                details={"kind": "sheet_wins_conflict", "message": f"Sheet values replaced app edits on {conflict['name']}",
                         "fields": conflict["fields"]},
            ))
        db.commit()
        return run

    def _open_issue(self, db: Session, user_id: uuid.UUID, item_id: uuid.UUID, issue_type: str) -> bool:
        return db.query(ReconciliationIssue.id).filter(
            ReconciliationIssue.user_id == user_id, ReconciliationIssue.provider == PROVIDER,
            ReconciliationIssue.inventory_item_id == item_id, ReconciliationIssue.issue_type == issue_type,
            ReconciliationIssue.status == "open",
        ).first() is not None

    # ── push (app -> sheet, one row) ───────────────────────────────────────

    async def push_row(self, db: Session, job: ProviderOutbox) -> str:
        link = self.get_link(db, job.user_id)
        if link is None:
            return "no_link"
        item = db.query(InventoryItem).filter(
            InventoryItem.id == job.inventory_item_id, InventoryItem.user_id == job.user_id
        ).first()
        if item is None or item.deleted_at is not None:
            return "item_deleted"
        values = await self._get_values(db, link)
        header = values[0] if values else []
        header_map = map_headers(header)
        if ID not in header_map:
            header_map = await self._ensure_id_column(db, link, header, header_map)
        id_col = header_map[ID]
        fields = [f for f in header_map if f != ID]
        state = dict(link.row_state or {})
        key = str(item.id)
        row_number, row = next(
            ((n + 2, r) for n, r in enumerate(values[1:]) if id_col < len(r) and _text(r[id_col]) == key),
            (None, None),
        )
        if row is None:
            if key in state and link.source_of_truth:
                return "row_deleted_in_sheet"  # sheet wins: the next pull archives or flags it
            if item.status == "archived":
                return "archived"
            await self._append_rows(db, link, [row_cells(item, header_map)])
            outcome = "appended"
        else:
            sv = sheet_values(row, header_map)
            snap = state.get(key)
            if link.source_of_truth and snap is not None and any(sv[f] != snap.get(f) for f in sv):
                return "sheet_changed"  # sheet wins: the next pull applies the sheet
            app = app_values(item, fields)
            data = [
                {"range": a1(link.sheet_tab, f"{column_letter(header_map[f])}{row_number}"),
                 "values": [[cell_value(item, f)]]}
                for f in fields if app[f] != sv.get(f)
            ]
            await self._write_cells(db, link, data)
            outcome = f"updated:{len(data)}"
        state[key] = app_values(item, fields)
        link.row_state = state
        link.header_map = header_map
        link.last_values_hash = None
        db.add(link)
        db.flush()
        return outcome


def _conflict_note(conflicts: list[dict]) -> Optional[str]:
    if not conflicts:
        return None
    parts = [f"{c['name']}: {', '.join(sorted(c['fields']))}" for c in conflicts[:10]]
    more = f" and {len(conflicts) - 10} more" if len(conflicts) > 10 else ""
    return "Sheet won over app edits on " + "; ".join(parts) + more


def enqueue_sheet_push(db: Session, item: InventoryItem, *, source_type: Optional[str] = None,
                       force: bool = False) -> Optional[ProviderOutbox]:
    """Queue a row push for *item* if the user has a linked sheet. Coalesces
    into a pending job for the same item (the job reads the item when it runs)."""
    if item.id is None or (source_type == PROVIDER and not force):
        return None
    if db.query(GoogleSheetLink.id).filter(GoogleSheetLink.user_id == item.user_id).first() is None:
        return None
    now = datetime.now(timezone.utc)
    existing = db.query(ProviderOutbox).filter(
        ProviderOutbox.provider == PROVIDER, ProviderOutbox.action == PUSH_ROW,
        ProviderOutbox.inventory_item_id == item.id, ProviderOutbox.status == "pending",
    ).first()
    if existing:
        existing.next_attempt_at = now
        db.add(existing)
        db.info["provider_outbox_pending"] = True
        return existing
    job = ProviderOutbox(
        user_id=item.user_id, provider=PROVIDER, action=PUSH_ROW, inventory_item_id=item.id,
        payload={"inventory_item_id": str(item.id)},
        idempotency_key=f"{PROVIDER}:{PUSH_ROW}:{item.id}:{uuid.uuid4().hex}",
        status="pending", attempts=0, next_attempt_at=now,
    )
    db.add(job)
    db.flush()
    db.info["provider_outbox_pending"] = True
    return job


async def pull_all(db: Session) -> int:
    """Periodic pull for every linked sheet (outbox sweep). Returns links processed."""
    if not google_sheets_service.is_configured():
        return 0
    user_ids = [row[0] for row in db.query(GoogleSheetLink.user_id).all()]
    for user_id in user_ids:
        try:
            await google_sheets_service.pull(db, user_id, trigger="periodic")
        except Exception:  # noqa: BLE001 - one user's sheet never stops the others
            db.rollback()
            logger.exception("Google Sheets periodic pull failed for a user")
    return len(user_ids)


def web_return_origin() -> str:
    parsed = urlparse(settings.GOOGLE_WEB_RETURN_URL)
    return f"{parsed.scheme}://{parsed.netloc}"


google_sheets_service = GoogleSheetsService()
