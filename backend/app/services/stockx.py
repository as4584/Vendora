"""StockX Public API v2 integration.

Built against the documented API (https://developer.stockx.com):
  OAuth2 authorization code   https://accounts.stockx.com/authorize
                               https://accounts.stockx.com/oauth/token  (audience gateway.stockx.com)
  Every API call              Authorization: Bearer <access token> + x-api-key: <STOCKX_API_KEY>
  Base                         https://api.stockx.com/v2

Features: catalog match (ranked with app.services.stockx_match), per-variant
market data with a short-TTL DB cache, asks (create/update/delete listings),
order import (exactly once, deducts stock), and auto-removal of asks when a
size sells out in Resqlo via the durable provider outbox.

The service degrades gracefully: missing app keys -> 503 "StockX not
configured"; no user token -> 409 "StockX not connected".

HTTP goes through ``self.transport`` (None in production) so tests can inject
an ``httpx.MockTransport``; ``self.sleep`` is injectable for backoff tests.
"""
from __future__ import annotations

import asyncio
import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Awaitable, Callable, ClassVar, Optional
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import HTTPException, status
from jwt.exceptions import InvalidTokenError as JWTError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models.inventory import InventoryExternalLink, InventoryItem
from app.models.provider import ProviderSyncRun
from app.models.provider_outbox import ProviderOutbox
from app.models.stockx import StockxListing, StockxMarketCache, StockxToken
from app.models.transaction import Transaction
from app.security.token_encryption import decrypt_token, encrypt_token
from app.services import stockx_match
from app.services.providers.base import ProviderAdapter, SyncResult

logger = logging.getLogger(__name__)

AUTH_URL = "https://accounts.stockx.com/authorize"
TOKEN_URL = "https://accounts.stockx.com/oauth/token"
AUDIENCE = "gateway.stockx.com"
API_BASE = "https://api.stockx.com/v2"
SCOPES = "offline_access openid"

PROVIDER = "stockx"
MARKET_TTL = timedelta(minutes=10)
MAX_429_RETRIES = 3
OUTBOX_BACKOFF_BASE = timedelta(seconds=30)
OPEN_LISTING_STATUSES = ("pending", "active")
SKIP_ORDER_STATUSES = ("CANCELED", "CANCELLED", "RETURNED", "FAILED", "DECLINED")
# StockX listing status -> stockx_listings.status (unknown values leave the row alone).
REMOTE_LISTING_STATUS = {
    "ACTIVE": "active",
    "INACTIVE": "inactive",
    "DELETED": "deleted",
    "CANCELED": "deleted",
    "CANCELLED": "deleted",
    "MATCHED": "sold",
    "COMPLETED": "sold",
}
# A pending ask StockX never surfaces within this long is marked failed.
PENDING_GIVE_UP = timedelta(hours=24)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

NOT_CONFIGURED = "StockX not configured"
NOT_CONNECTED = "StockX not connected"


class StockxAPIError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


# ── pure helpers ─────────────────────────────────────────────────────────────

def money(value: Any) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return None


def normalize_size(size: Any) -> str:
    """'US M 10.5' / 'Size 10.5' / '10.5' -> '10.5'. Non-numeric sizes lowercased."""
    text = str(size or "").strip().lower()
    text = re.sub(r"\b(us|uk|eu|size|sz|men'?s|women'?s)\b", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    match = re.search(r"\d+(\.\d+)?", text)
    if match:
        return format(Decimal(match.group(0)).normalize(), "f")
    return text


def variant_size(variant: dict) -> str:
    chart = variant.get("sizeChart") or {}
    default = chart.get("defaultConversion") or {}
    return str(variant.get("variantValue") or default.get("size") or "")


def find_variant(variants: list[dict], size: Optional[str]) -> Optional[dict]:
    if not variants:
        return None
    if not size:
        return variants[0] if len(variants) == 1 else None
    wanted = normalize_size(size)
    for variant in variants:
        if normalize_size(variant_size(variant)) == wanted:
            return variant
    return None


def item_sizes(item: InventoryItem) -> list[tuple[str, int]]:
    """(size, quantity) pairs for an item: per-size variants, else the single size."""
    variants = (item.custom_attributes or {}).get("variants")
    rows: list[tuple[str, int]] = []
    if isinstance(variants, list):
        for variant in variants:
            if isinstance(variant, dict) and str(variant.get("size") or "").strip():
                rows.append((str(variant["size"]).strip(), int(variant.get("quantity") or 0)))
    if rows:
        return rows
    return [(item.size or "", int(item.quantity or 0))]


def remaining_for_size(item: InventoryItem, size: Optional[str]) -> int:
    if item.deleted_at or item.status in ("sold", "shipped", "paid", "archived"):
        return 0
    wanted = normalize_size(size)
    for row_size, qty in item_sizes(item):
        if normalize_size(row_size) == wanted:
            return qty
    return max(int(item.quantity or 0), 0)


def parse_market(data: dict) -> dict[str, Optional[Decimal]]:
    """Map StockX market-data JSON to our fields. Asks are never read as sales."""
    return {
        "lowest_ask": money(data.get("lowestAskAmount")),
        "highest_bid": money(data.get("highestBidAmount")),
        # Only an explicit last-sale field counts as a sale price.
        "last_sale": money(data.get("lastSaleAmount") or data.get("lastSale")),
    }


# ── service ──────────────────────────────────────────────────────────────────

class StockxService(ProviderAdapter):
    provider: ClassVar[str] = PROVIDER

    def __init__(self) -> None:
        self.transport: Optional[httpx.AsyncBaseTransport] = None
        self.sleep: Callable[[float], Awaitable[None]] = asyncio.sleep

    # settings are read live so tests (and hot config) can toggle them
    @property
    def api_key(self) -> str:
        return settings.STOCKX_API_KEY

    @property
    def client_id(self) -> str:
        return settings.STOCKX_CLIENT_ID

    @property
    def client_secret(self) -> str:
        return settings.STOCKX_CLIENT_SECRET

    @property
    def redirect_uri(self) -> str:
        return settings.STOCKX_REDIRECT_URI

    def is_configured(self) -> bool:
        return bool(self.api_key and self.client_id and self.client_secret and self.redirect_uri)

    def assert_configured(self) -> None:
        if not self.is_configured():
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=NOT_CONFIGURED)

    def _client(self, timeout: float = 20) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=timeout, transport=self.transport)

    # ── ProviderAdapter ────────────────────────────────────────────────────────

    def is_connected(self, db: Session, user_id: uuid.UUID) -> bool:
        return self.get_token(db, user_id) is not None

    def get_connection_id(self, db: Session, user_id: uuid.UUID) -> Optional[str]:
        token = self.get_token(db, user_id)
        return token.account_id if token else None

    # ── OAuth ──────────────────────────────────────────────────────────────────

    def build_state(self, user_id: uuid.UUID) -> str:
        payload = {
            "sub": str(user_id),
            "purpose": "stockx_oauth",
            "nonce": secrets.token_urlsafe(16),
            "exp": datetime.now(timezone.utc) + timedelta(minutes=10),
        }
        return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

    def parse_state(self, state: str) -> uuid.UUID:
        try:
            payload = jwt.decode(state, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            if payload.get("purpose") != "stockx_oauth":
                raise ValueError("invalid state purpose")
            return uuid.UUID(payload["sub"])
        except (JWTError, KeyError, TypeError, ValueError) as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid StockX state parameter") from exc

    def authorization_url(self, state: str) -> str:
        self.assert_configured()
        params = urlencode(
            {
                "response_type": "code",
                "client_id": self.client_id,
                "redirect_uri": self.redirect_uri,
                "scope": SCOPES,
                "audience": AUDIENCE,
                "state": state,
            }
        )
        return f"{AUTH_URL}?{params}"

    async def _token_request(self, data: dict) -> dict:
        self.assert_configured()
        async with self._client() as client:
            resp = await client.post(
                TOKEN_URL,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={**data, "client_id": self.client_id, "client_secret": self.client_secret},
            )
        if resp.status_code >= 400:
            logger.error("StockX token request failed %s", resp.status_code)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail="StockX token request failed")
        payload = resp.json()
        payload["expires_at"] = datetime.now(timezone.utc) + timedelta(
            seconds=int(payload.get("expires_in", 43200))
        )
        return payload

    async def exchange_authorization_code(self, code: str) -> dict:
        return await self._token_request(
            {"grant_type": "authorization_code", "code": code, "redirect_uri": self.redirect_uri}
        )

    async def refresh(self, db: Session, token: StockxToken) -> StockxToken:
        try:
            payload = await self._token_request(
                {
                    "grant_type": "refresh_token",
                    "refresh_token": decrypt_token(token.refresh_token),
                    "audience": AUDIENCE,
                }
            )
        except HTTPException as exc:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, detail="StockX session expired, please reconnect."
            ) from exc
        token.access_token = encrypt_token(payload["access_token"])
        token.expires_at = payload["expires_at"]
        if payload.get("refresh_token"):
            token.refresh_token = encrypt_token(payload["refresh_token"])
        db.add(token)
        db.flush()
        return token

    # ── token CRUD ─────────────────────────────────────────────────────────────

    def get_token(self, db: Session, user_id: uuid.UUID) -> Optional[StockxToken]:
        return db.query(StockxToken).filter(StockxToken.user_id == user_id).one_or_none()

    def upsert_token(self, db: Session, *, user_id: uuid.UUID, payload: dict) -> StockxToken:
        token = self.get_token(db, user_id)
        if token is None:
            token = StockxToken(user_id=user_id)
        token.access_token = encrypt_token(payload["access_token"])
        token.refresh_token = encrypt_token(payload.get("refresh_token") or "")
        token.expires_at = payload["expires_at"]
        token.scopes = payload.get("scope")
        db.add(token)
        db.commit()
        db.refresh(token)
        return token

    def disconnect(self, db: Session, user_id: uuid.UUID) -> int:
        token = self.get_token(db, user_id)
        if token:
            db.delete(token)
            db.commit()
        return (
            db.query(InventoryExternalLink)
            .filter(InventoryExternalLink.user_id == user_id, InventoryExternalLink.provider == PROVIDER)
            .count()
        )

    def require_token(self, db: Session, user_id: uuid.UUID) -> StockxToken:
        self.assert_configured()
        token = self.get_token(db, user_id)
        if token is None:
            raise HTTPException(status.HTTP_409_CONFLICT, detail=NOT_CONNECTED)
        return token

    # ── HTTP ───────────────────────────────────────────────────────────────────

    async def request(
        self,
        db: Session,
        user_id: uuid.UUID,
        method: str,
        path: str,
        *,
        params: Optional[dict] = None,
        json: Optional[dict] = None,
    ) -> Any:
        """Authenticated API call: refreshes near expiry and once on 401,
        backs off on 429 (Retry-After or exponential) up to MAX_429_RETRIES."""
        token = self.require_token(db, user_id)
        if token.expires_at - datetime.now(timezone.utc) < timedelta(minutes=5):
            token = await self.refresh(db, token)
        refreshed = False
        attempt = 0
        while True:
            headers = {
                "Authorization": f"Bearer {decrypt_token(token.access_token)}",
                "x-api-key": self.api_key,
                "Accept": "application/json",
            }
            async with self._client(30) as client:
                resp = await client.request(method, f"{API_BASE}{path}", headers=headers, params=params, json=json)
            if resp.status_code == 429 and attempt < MAX_429_RETRIES:
                retry_after = resp.headers.get("Retry-After")
                try:
                    delay = min(float(retry_after), 60.0) if retry_after else 2.0 ** attempt
                except ValueError:
                    delay = 2.0 ** attempt
                attempt += 1
                logger.warning("StockX rate limited; retry %d in %.1fs", attempt, delay)
                await self.sleep(delay)
                continue
            if resp.status_code == 401 and not refreshed:
                refreshed = True
                token = await self.refresh(db, token)
                continue
            if resp.status_code >= 400:
                raise StockxAPIError(resp.status_code, _error_message(resp))
            if resp.status_code == 204 or not resp.content:
                return {}
            return resp.json()

    # ── catalog / match ────────────────────────────────────────────────────────

    async def search(self, db: Session, user_id: uuid.UUID, query: str) -> list[dict]:
        data = await self.request(db, user_id, "GET", "/catalog/search", params={"query": query, "pageSize": 20})
        return list((data or {}).get("products") or [])

    async def get_variants(self, db: Session, user_id: uuid.UUID, product_id: str) -> list[dict]:
        data = await self.request(db, user_id, "GET", f"/catalog/products/{product_id}/variants")
        if isinstance(data, dict):
            data = data.get("variants") or []
        return list(data or [])

    async def match_item(self, db: Session, user_id: uuid.UUID, item: InventoryItem) -> dict:
        """Search the catalog for an item; a style-code hit beats name ranking."""
        query = item.name if not item.sku else f"{item.name} {item.sku}"
        products = await self.search(db, user_id, query)
        if not products and item.sku:
            products = await self.search(db, user_id, item.name)
        titles = [str(p.get("title") or "") for p in products]
        best, ranked = stockx_match.best_match(item.name, titles, refs=products)
        shortlist = [_candidate_out(c.ref, c.score) for c in ranked]
        best_out = _candidate_out(best.ref, best.score) if best else None
        if item.sku:
            sku = stockx_match.normalize(item.sku).replace(" ", "")
            for product in products:
                style = stockx_match.normalize(str(product.get("styleId") or "")).replace(" ", "")
                if style and style == sku:
                    best_out = _candidate_out(product, 1.0)
                    break
        return {"best": best_out, "shortlist": shortlist}

    async def confirm_match(
        self, db: Session, user_id: uuid.UUID, item: InventoryItem, product_id: str,
        size_overrides: Optional[dict[str, str]] = None,
    ) -> list[InventoryExternalLink]:
        """Store productId + per-size variantId links for an item (replacing old ones)."""
        variants = await self.get_variants(db, user_id, product_id)
        overrides = size_overrides or {}
        by_id = {str(v.get("variantId")): v for v in variants}
        (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.inventory_item_id == item.id,
                InventoryExternalLink.provider == PROVIDER,
            )
            .delete(synchronize_session=False)
        )
        links: list[InventoryExternalLink] = []
        now = datetime.now(timezone.utc)
        for size, _qty in item_sizes(item):
            variant = by_id.get(overrides.get(size, "")) or find_variant(variants, size)
            if variant is None:
                continue
            variant_id = str(variant["variantId"])
            if any(existing.external_sku == variant_id for existing in links):
                continue  # one variant maps to one local size
            link = InventoryExternalLink(
                inventory_item_id=item.id,
                user_id=user_id,
                provider=PROVIDER,
                external_id=f"{variant_id}:{item.id}",
                external_parent_id=product_id,
                external_sku=variant_id,
                variant_label=size or variant_size(variant) or None,
                last_synced_at=now,
            )
            db.add(link)
            links.append(link)
        db.commit()
        return links

    @staticmethod
    def links_for_item(db: Session, item_id: uuid.UUID) -> list[InventoryExternalLink]:
        return (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.inventory_item_id == item_id,
                InventoryExternalLink.provider == PROVIDER,
            )
            .order_by(InventoryExternalLink.variant_label)
            .all()
        )

    # ── market data ────────────────────────────────────────────────────────────

    async def market_data(
        self, db: Session, user_id: uuid.UUID, product_id: str, variant_id: str,
        currency: str = "USD", now: Optional[datetime] = None,
    ) -> dict:
        now = now or datetime.now(timezone.utc)
        cached = (
            db.query(StockxMarketCache)
            .filter(StockxMarketCache.variant_id == variant_id, StockxMarketCache.currency_code == currency)
            .one_or_none()
        )
        if cached and now - cached.fetched_at < MARKET_TTL:
            return _market_out(cached, stale=False)
        try:
            data = await self.request(
                db, user_id, "GET",
                f"/catalog/products/{product_id}/variants/{variant_id}/market-data",
                params={"currencyCode": currency},
            )
        except StockxAPIError as exc:
            if cached:  # serve stale rather than nothing (rate limits, outages)
                return _market_out(cached, stale=True)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=f"StockX market data unavailable: {exc.message}")
        fields = parse_market(data or {})
        if cached is None:
            cached = StockxMarketCache(product_id=product_id, variant_id=variant_id, currency_code=currency)
        cached.lowest_ask = fields["lowest_ask"]
        cached.highest_bid = fields["highest_bid"]
        cached.last_sale = fields["last_sale"]
        cached.raw = data
        cached.fetched_at = now
        db.add(cached)
        try:
            db.commit()
        except IntegrityError:  # concurrent first fetch of the same variant
            db.rollback()
        return _market_out(cached, stale=False)

    # ── listings (asks) ────────────────────────────────────────────────────────

    def _link_for(self, db: Session, item: InventoryItem, variant_id: str) -> InventoryExternalLink:
        link = (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.inventory_item_id == item.id,
                InventoryExternalLink.provider == PROVIDER,
                InventoryExternalLink.external_sku == variant_id,
            )
            .first()
        )
        if link is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Match this item on StockX first.")
        return link

    async def create_listing(
        self, db: Session, user_id: uuid.UUID, item: InventoryItem, variant_id: str, amount: Decimal,
        currency: str = "USD",
    ) -> StockxListing:
        link = self._link_for(db, item, variant_id)
        if remaining_for_size(item, link.variant_label) <= 0:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="No stock left for this size.")
        existing = (
            db.query(StockxListing)
            .filter(
                StockxListing.inventory_item_id == item.id,
                StockxListing.variant_id == variant_id,
                StockxListing.status.in_(OPEN_LISTING_STATUSES),
            )
            .first()
        )
        if existing:
            return await self.update_listing(db, user_id, existing, amount)
        listing = StockxListing(
            user_id=user_id, inventory_item_id=item.id, product_id=link.external_parent_id or "",
            variant_id=variant_id, size=link.variant_label, amount=amount, currency_code=currency,
            status="pending",
        )
        db.add(listing)
        db.flush()
        try:
            data = await self.request(
                db, user_id, "POST", "/selling/listings",
                json={"amount": str(amount), "variantId": variant_id, "currencyCode": currency, "active": True},
            )
        except StockxAPIError as exc:
            listing.status = "failed"
            listing.last_error = exc.message
            db.commit()
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=f"StockX rejected the ask: {exc.message}")
        listing.listing_id = str(data.get("listingId") or "") or None
        listing.status = "active" if listing.listing_id else "pending"
        listing.last_error = None
        db.commit()
        db.refresh(listing)
        return listing

    async def update_listing(
        self, db: Session, user_id: uuid.UUID, listing: StockxListing, amount: Decimal
    ) -> StockxListing:
        if not listing.listing_id:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="StockX has not confirmed this ask yet.")
        try:
            await self.request(
                db, user_id, "PATCH", f"/selling/listings/{listing.listing_id}",
                json={"amount": str(amount), "currencyCode": listing.currency_code},
            )
        except StockxAPIError as exc:
            listing.last_error = exc.message
            db.commit()
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=f"StockX rejected the update: {exc.message}")
        listing.amount = amount
        listing.status = "active"
        listing.last_error = None
        db.commit()
        db.refresh(listing)
        return listing

    async def delete_listing(self, db: Session, user_id: uuid.UUID, listing: StockxListing) -> StockxListing:
        """Remove an ask. Idempotent: an already-gone listing (404) counts as removed."""
        if listing.listing_id and listing.status in OPEN_LISTING_STATUSES + ("inactive",):
            try:
                await self.request(db, user_id, "DELETE", f"/selling/listings/{listing.listing_id}")
            except StockxAPIError as exc:
                if exc.status_code != 404:
                    listing.last_error = exc.message
                    db.commit()
                    raise
        if listing.status != "sold":
            listing.status = "deleted"
        listing.last_error = None
        db.commit()
        return listing

    async def recheck_pending_listings(
        self, db: Session, user_id: uuid.UUID, item_id: Optional[uuid.UUID] = None,
        now: Optional[datetime] = None,
    ) -> int:
        """Resolve asks still "pending" (StockX accepted the create but returned
        no listingId yet). With an id, read that listing; without one, find our
        ask among the seller's listings for the same variant + amount. Asks that
        never show up within PENDING_GIVE_UP are marked failed so they don't sit
        pending forever. Returns how many rows changed."""
        now = now or datetime.now(timezone.utc)
        query = db.query(StockxListing).filter(
            StockxListing.user_id == user_id, StockxListing.status == "pending"
        )
        if item_id is not None:
            query = query.filter(StockxListing.inventory_item_id == item_id)
        pending = query.order_by(StockxListing.created_at).all()
        if not pending:
            return 0
        changed = 0
        remote_by_variant: dict[str, list[dict]] = {}
        for listing in pending:
            try:
                if listing.listing_id:
                    remote = await self.request(db, user_id, "GET", f"/selling/listings/{listing.listing_id}")
                else:
                    if listing.variant_id not in remote_by_variant:
                        data = await self.request(
                            db, user_id, "GET", "/selling/listings",
                            params={"variantIds": listing.variant_id, "pageNumber": 1, "pageSize": 100},
                        )
                        remote_by_variant[listing.variant_id] = list((data or {}).get("listings") or [])
                    remote = self._claim_remote_listing(db, listing, remote_by_variant[listing.variant_id])
            except StockxAPIError as exc:
                if exc.status_code == 404 and listing.listing_id:
                    listing.status = "deleted"
                    listing.last_error = None
                    changed += 1
                else:
                    listing.last_error = exc.message
                continue
            if remote:
                listing.listing_id = listing.listing_id or str(remote.get("listingId") or "") or None
                # Still PENDING on StockX: keep the id, re-read it next time.
                mapped = REMOTE_LISTING_STATUS.get(str(remote.get("status") or "").upper())
                if mapped:
                    listing.status = mapped
                listing.last_error = None
                changed += 1
            elif now - _aware(listing.created_at) > PENDING_GIVE_UP:
                listing.status = "failed"
                listing.last_error = "StockX never confirmed this ask. List it again."
                changed += 1
        db.commit()
        return changed

    @staticmethod
    def _claim_remote_listing(db: Session, listing: StockxListing, remote: list[dict]) -> Optional[dict]:
        """First remote listing for this variant + amount not already tied to a row."""
        for row in remote:
            remote_id = str(row.get("listingId") or "")
            variant = (row.get("variant") or {}).get("variantId") or row.get("variantId")
            if not remote_id or variant != listing.variant_id:
                continue
            if money(row.get("amount")) != Decimal(listing.amount):
                continue
            taken = db.query(StockxListing.id).filter(StockxListing.listing_id == remote_id).first()
            if taken:
                continue
            remote.remove(row)
            return row
        return None

    # ── orders ─────────────────────────────────────────────────────────────────

    async def _orders(self, db: Session, user_id: uuid.UUID, path: str) -> list[dict]:
        out: list[dict] = []
        page = 1
        while page <= 20:
            data = await self.request(db, user_id, "GET", path, params={"pageNumber": page, "pageSize": 100})
            out.extend((data or {}).get("orders") or [])
            if not (data or {}).get("hasNextPage"):
                break
            page += 1
        return out

    def import_order(self, db: Session, user_id: uuid.UUID, order: dict, run: Optional[ProviderSyncRun] = None) -> str:
        """Import one StockX sale exactly once. Returns 'imported'|'existing'|'skipped'."""
        from app.services.inventory import deduct_stock  # local: avoid import cycle

        order_number = str(order.get("orderNumber") or "")
        if not order_number or str(order.get("status") or "").upper() in SKIP_ORDER_STATUSES:
            return "skipped"
        if (
            db.query(Transaction.id)
            .filter(
                Transaction.user_id == user_id,
                Transaction.source == PROVIDER,
                Transaction.external_reference_id == order_number,
            )
            .first()
        ):
            return "existing"
        listing_id = str(order.get("listingId") or "")
        variant_id = str((order.get("variant") or {}).get("variantId") or "")
        listing = (
            db.query(StockxListing)
            .filter(StockxListing.user_id == user_id, StockxListing.listing_id == listing_id)
            .first()
            if listing_id else None
        )
        item: Optional[InventoryItem] = None
        size: Optional[str] = None
        if listing:
            item = db.get(InventoryItem, listing.inventory_item_id)
            size = listing.size
            listing.status = "sold"  # before deducting, so the sell-out hook skips it
            db.add(listing)
        elif variant_id:
            link = (
                db.query(InventoryExternalLink)
                .filter(
                    InventoryExternalLink.user_id == user_id,
                    InventoryExternalLink.provider == PROVIDER,
                    InventoryExternalLink.external_sku == variant_id,
                )
                .first()
            )
            if link:
                item = db.get(InventoryItem, link.inventory_item_id)
                size = link.variant_label
        if item is None or item.deleted_at is not None:
            self.record_issue(
                db, user_id, issue_type="missing_item", severity="warning", run=run,
                external_id=order_number, details={"listingId": listing_id, "variantId": variant_id},
            )
            return "skipped"

        gross = money(order.get("amount")) or Decimal("0.00")
        payout = money((order.get("payout") or {}).get("totalPayout"))
        fee = (gross - payout) if payout is not None and payout <= gross else Decimal("0.00")
        txn = Transaction(
            user_id=user_id, item_id=item.id, method="other", status="completed",
            gross_amount=gross, fee_amount=fee, net_amount=gross - fee, quantity=1,
            external_reference_id=order_number, source=PROVIDER, variant_size=size or None,
            notes=f"StockX order #{order_number}",
        )
        db.add(txn)
        db.flush()
        _deduct_size(item, size, 1)
        item.actual_sell_price = gross
        db.add(item)
        try:
            deduct_stock(
                db, item, quantity=1, event_type="sale", source_type=PROVIDER,
                source_id=order_number, idempotency_key=f"stockx:order:{order_number}",
            )
        except HTTPException:
            # Sold on StockX but Resqlo already shows 0: keep the sale, flag drift.
            self.record_issue(
                db, user_id, issue_type="stock_drift", severity="warning", run=run,
                external_id=order_number, inventory_item_id=item.id,
                details={"reason": "sold on StockX with no Resqlo stock"},
            )
        return "imported"

    async def _do_sync(self, db: Session, user_id: uuid.UUID, run: ProviderSyncRun) -> SyncResult:
        result = SyncResult(run_id=run.id)
        # Per-listing API errors are recorded on the row, so this never blocks the import.
        await self.recheck_pending_listings(db, user_id)
        orders = await self._orders(db, user_id, "/selling/orders/active")
        orders += await self._orders(db, user_id, "/selling/orders/history")
        seen: set[str] = set()
        for order in orders:
            number = str(order.get("orderNumber") or "")
            if number in seen:
                continue
            seen.add(number)
            outcome = self.import_order(db, user_id, order, run)
            if outcome == "imported":
                result.transactions_imported += 1
            elif outcome == "existing":
                result.transactions_updated += 1
            else:
                result.items_skipped += 1
            db.commit()
        return result


def _deduct_size(item: InventoryItem, size: Optional[str], quantity: int) -> None:
    from sqlalchemy.orm.attributes import flag_modified

    if not size:
        return
    attrs = dict(item.custom_attributes or {})
    variants = attrs.get("variants")
    if not isinstance(variants, list):
        return
    wanted = normalize_size(size)
    for variant in variants:
        if isinstance(variant, dict) and normalize_size(variant.get("size")) == wanted:
            variant["quantity"] = max(0, int(variant.get("quantity") or 0) - quantity)
            item.custom_attributes = attrs
            flag_modified(item, "custom_attributes")
            return


def _error_message(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        if isinstance(body, dict):
            return str(body.get("errorMessage") or body.get("message") or body.get("error") or resp.status_code)
    except ValueError:
        pass
    return f"HTTP {resp.status_code}"


def _candidate_out(product: Any, score: float) -> dict:
    product = product or {}
    attrs = product.get("productAttributes") or {}
    return {
        "product_id": str(product.get("productId") or ""),
        "title": str(product.get("title") or ""),
        "style_id": product.get("styleId"),
        "brand": product.get("brand"),
        "colorway": attrs.get("colorway"),
        "score": score,
    }


def _market_out(row: StockxMarketCache, stale: bool) -> dict:
    return {
        "product_id": row.product_id,
        "variant_id": row.variant_id,
        "currency_code": row.currency_code,
        "lowest_ask": row.lowest_ask,
        "highest_bid": row.highest_bid,
        "last_sale": row.last_sale,
        "fetched_at": row.fetched_at,
        "stale": stale,
    }


stockx_service = StockxService()


# ── outbox ───────────────────────────────────────────────────────────────────

def enqueue_sellout_delists(db: Session, item: InventoryItem) -> int:
    """Called inside the stock-deduction transaction. For every open StockX ask
    on a size that now has 0 left, write a durable delete job (idempotent)."""
    listings = (
        db.query(StockxListing)
        .filter(
            StockxListing.inventory_item_id == item.id,
            StockxListing.status.in_(OPEN_LISTING_STATUSES),
        )
        .all()
    )
    queued = 0
    for listing in listings:
        if remaining_for_size(item, listing.size) > 0:
            continue
        key = f"stockx:delete_listing:{listing.id}"
        if db.query(ProviderOutbox.id).filter(ProviderOutbox.idempotency_key == key).first():
            continue
        db.add(
            ProviderOutbox(
                user_id=listing.user_id, provider=PROVIDER, action="delete_listing",
                payload={"stockx_listing_id": str(listing.id)}, idempotency_key=key,
                status="pending", attempts=0, next_attempt_at=datetime.now(timezone.utc),
            )
        )
        queued += 1
    if queued:
        db.flush()
        db.info["provider_outbox_pending"] = True
    return queued


async def process_job(db: Session, job: ProviderOutbox, now: Optional[datetime] = None) -> None:
    now = now or datetime.now(timezone.utc)
    job.status = "processing"
    job.attempts = (job.attempts or 0) + 1
    db.commit()
    try:
        if job.provider != PROVIDER or job.action != "delete_listing":
            raise ValueError(f"unknown job {job.provider}/{job.action}")
        listing = db.get(StockxListing, uuid.UUID(job.payload["stockx_listing_id"]))
        if listing is not None:
            await stockx_service.delete_listing(db, listing.user_id, listing)
    except Exception as exc:  # noqa: BLE001 - every failure is recorded and retried
        db.rollback()
        detail = exc.detail if isinstance(exc, HTTPException) else getattr(exc, "message", str(exc))
        job.last_error = str(detail)[:2000]
        if job.attempts >= job.max_attempts:
            job.status = "failed"
            job.next_attempt_at = None
        else:
            job.status = "pending"
            job.next_attempt_at = now + OUTBOX_BACKOFF_BASE * (2 ** (job.attempts - 1))
        db.commit()
        return
    job.status = "done"
    job.last_error = None
    job.completed_at = now
    job.next_attempt_at = None
    db.commit()


async def process_outbox(
    db: Session, user_id: Optional[uuid.UUID] = None, now: Optional[datetime] = None, limit: int = 50
) -> int:
    """StockX-only view of the shared processor (app.services.outbox)."""
    from app.services.outbox import process_outbox as shared

    return await shared(db, user_id=user_id, now=now, limit=limit, provider=PROVIDER)
