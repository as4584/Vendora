"""eBay Sell API integration — OAuth + pull-only (import) sync.

v1 scope: read-only. Pulls the seller's Inventory API items into Resqlo
inventory and Fulfillment API orders into Resqlo transactions. No write-back
(no listing creation) — that is a separate, larger effort.

Environment (sandbox vs production) is selected via ``settings.EBAY_ENV``.
Scope identifier strings always use the ``api.ebay.com`` host for both
environments; only the auth/token/API hosts differ.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, ClassVar, Optional
import uuid
import xml.etree.ElementTree as ET
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, status
import jwt
from jwt.exceptions import InvalidTokenError as JWTError
from sqlalchemy.orm import Session

from app.services.push import notify_ebay_sales
from app.config import settings
from app.models.integration import EbayToken
from app.models.inventory import InventoryItem, InventoryExternalLink, InventoryStockLedger
from app.models.provider import ProviderSyncRun
from app.models.transaction import Transaction
from app.security.token_encryption import decrypt_token, encrypt_token
from app.services.providers.base import ProviderAdapter, SyncResult

logger = logging.getLogger(__name__)

_PAGE_SIZE = 100
_ORDER_PAGE_SIZE = 50
_LISTING_PAGE_SIZE = 200
_TRADING_NS = {"e": "urn:ebay:apis:eBLBaseComponents"}
_RATE_LIMIT_SLEEP = 0.2  # small pause between paged/offer calls

# Scope identifiers are host-fixed to api.ebay.com for BOTH sandbox and production.
# sell.inventory + sell.account are needed to create/revise/end listings and to
# read business policies; existing read-only connections must reconnect.
LISTING_SCOPES = [
    "https://api.ebay.com/oauth/api_scope",
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
    # Insights: payout fees, listing traffic, real-time order notifications.
    # (Send-offer-to-watchers, Negotiation API, is covered by sell.inventory.)
    "https://api.ebay.com/oauth/api_scope/sell.finances",
    "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
    "https://api.ebay.com/oauth/api_scope/commerce.notification.subscription",
]
_SCOPES = " ".join(LISTING_SCOPES)


class EbayService(ProviderAdapter):
    provider: ClassVar[str] = "ebay"
    # Tests inject an httpx.MockTransport here; None = real network.
    transport: Optional[httpx.AsyncBaseTransport] = None
    requested_scopes: ClassVar[list[str]] = LISTING_SCOPES

    def __init__(self) -> None:
        self.client_id = settings.EBAY_CLIENT_ID
        self.client_secret = settings.EBAY_CLIENT_SECRET
        self.runame = settings.EBAY_RUNAME
        self.env = (settings.EBAY_ENV or "sandbox").lower()

    # ── environment-derived hosts ──────────────────────────────────────────────

    @property
    def _sandbox(self) -> bool:
        return self.env != "production"

    @property
    def auth_url(self) -> str:
        host = "auth.sandbox.ebay.com" if self._sandbox else "auth.ebay.com"
        return f"https://{host}/oauth2/authorize"

    @property
    def token_url(self) -> str:
        host = "api.sandbox.ebay.com" if self._sandbox else "api.ebay.com"
        return f"https://{host}/identity/v1/oauth2/token"

    @property
    def api_base(self) -> str:
        host = "api.sandbox.ebay.com" if self._sandbox else "api.ebay.com"
        return f"https://{host}"

    @property
    def identity_base(self) -> str:
        host = "apiz.sandbox.ebay.com" if self._sandbox else "apiz.ebay.com"
        return f"https://{host}"

    # ── ProviderAdapter interface ───────────────────────────────────────────────

    def is_connected(self, db: Session, user_id: uuid.UUID) -> bool:
        return self.get_token(db, user_id) is not None

    def get_connection_id(self, db: Session, user_id: uuid.UUID) -> Optional[str]:
        token = self.get_token(db, user_id)
        return token.account_id if token else None

    # ── OAuth helpers ────────────────────────────────────────────────────────────

    def _assert_configured(self) -> None:
        if not (self.client_id and self.client_secret and self.runame):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="eBay integration is not configured yet.",
            )

    def _basic_auth_header(self) -> str:
        raw = f"{self.client_id}:{self.client_secret}".encode()
        return "Basic " + base64.b64encode(raw).decode()

    def build_state(self, user_id: uuid.UUID, ret: str = "app") -> str:
        payload = {
            "sub": str(user_id),
            "purpose": "ebay_oauth",
            "nonce": secrets.token_urlsafe(16),
            "exp": datetime.now(timezone.utc) + timedelta(minutes=10),
            "ret": ret,
        }
        return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

    def parse_state(self, state: str) -> uuid.UUID:
        try:
            payload = jwt.decode(state, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            if payload.get("purpose") != "ebay_oauth":
                raise ValueError("invalid state purpose")
            return uuid.UUID(payload["sub"])
        except (JWTError, KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid eBay state parameter",
            ) from exc

    def authorization_url(self, state: str) -> str:
        """Build the eBay consent URL. ``redirect_uri`` is the RuName, per eBay OAuth."""
        self._assert_configured()
        params = urlencode(
            {
                "client_id": self.client_id,
                "redirect_uri": self.runame,
                "response_type": "code",
                "scope": _SCOPES,
                "state": state,
            }
        )
        return f"{self.auth_url}?{params}"

    async def exchange_authorization_code(self, code: str) -> dict:
        self._assert_configured()
        async with httpx.AsyncClient(timeout=20, transport=self.transport) as client:
            resp = await client.post(
                self.token_url,
                headers={
                    "Authorization": self._basic_auth_header(),
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": self.runame,
                },
            )
        if resp.status_code >= 400:
            logger.error("eBay token exchange failed %s: %s", resp.status_code, resp.text)
            raise HTTPException(resp.status_code, detail="eBay token exchange failed")
        payload = resp.json()
        payload["expires_at"] = datetime.now(timezone.utc) + timedelta(
            seconds=payload.get("expires_in", 7200)
        )
        return payload

    async def _refresh_access_token(self, db: Session, token: EbayToken) -> EbayToken:
        self._assert_configured()
        async with httpx.AsyncClient(timeout=20, transport=self.transport) as client:
            resp = await client.post(
                self.token_url,
                headers={
                    "Authorization": self._basic_auth_header(),
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": decrypt_token(token.refresh_token),
                    "scope": _SCOPES,
                },
            )
        if resp.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="eBay token refresh failed — please reconnect.",
            )
        payload = resp.json()
        token.access_token = encrypt_token(payload["access_token"])
        token.expires_at = datetime.now(timezone.utc) + timedelta(
            seconds=payload.get("expires_in", 7200)
        )
        # eBay only returns a new refresh_token on rotation; keep the old one otherwise.
        if payload.get("refresh_token"):
            token.refresh_token = encrypt_token(payload["refresh_token"])
        db.commit()
        db.refresh(token)
        logger.info("eBay token refreshed for user %s", token.user_id)
        return token

    async def _ensure_valid_token(self, db: Session, token: EbayToken) -> EbayToken:
        if token.expires_at - datetime.now(timezone.utc) < timedelta(minutes=5):
            token = await self._refresh_access_token(db, token)
        return token

    async def fetch_username(self, access_token: str) -> Optional[str]:
        """Best-effort eBay username lookup (Identity API). Returns None on failure."""
        try:
            async with httpx.AsyncClient(timeout=15, transport=self.transport) as client:
                resp = await client.get(
                    f"{self.identity_base}/commerce/identity/v1/user/",
                    headers={"Authorization": f"Bearer {access_token}"},
                )
            if resp.status_code >= 400:
                return None
            return resp.json().get("username")
        except Exception:  # pragma: no cover - identity lookup is non-critical
            return None

    # ── Token CRUD ──────────────────────────────────────────────────────────────

    def upsert_token(
        self,
        db: Session,
        *,
        user_id: uuid.UUID,
        account_id: Optional[str],
        access_token: str,
        refresh_token: str,
        expires_at: datetime,
        scopes: Optional[str] = None,
    ) -> EbayToken:
        token = db.query(EbayToken).filter(EbayToken.user_id == user_id).one_or_none()
        if token:
            token.account_id = account_id
            token.access_token = encrypt_token(access_token)
            token.refresh_token = encrypt_token(refresh_token)
            token.expires_at = expires_at
            token.scopes = scopes
        else:
            token = EbayToken(
                user_id=user_id,
                account_id=account_id,
                access_token=encrypt_token(access_token),
                refresh_token=encrypt_token(refresh_token),
                expires_at=expires_at,
                scopes=scopes,
            )
            db.add(token)
        db.commit()
        db.refresh(token)
        return token

    def get_token(self, db: Session, user_id: uuid.UUID) -> Optional[EbayToken]:
        return db.query(EbayToken).filter(EbayToken.user_id == user_id).one_or_none()

    def disconnect(self, db: Session, user_id: uuid.UUID) -> int:
        """Delete OAuth credentials while retaining links for safe reconnect."""
        token = self.get_token(db, user_id)
        if token:
            db.delete(token)
            db.commit()
        return (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.user_id == user_id,
                InventoryExternalLink.provider == "ebay",
            )
            .count()
        )

    # ── eBay API helpers ──────────────────────────────────────────────────────────

    async def _get_json(
        self, access_token: str, url: str, params: Optional[dict] = None
    ) -> Optional[dict]:
        headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
        async with httpx.AsyncClient(timeout=30, transport=self.transport) as client:
            resp = await client.get(url, headers=headers, params=params or {})
        if resp.status_code == 429:
            logger.warning("eBay rate limit hit, sleeping 30s")
            await asyncio.sleep(30)
            async with httpx.AsyncClient(timeout=30, transport=self.transport) as client:
                resp = await client.get(url, headers=headers, params=params or {})
        if resp.status_code >= 400:
            logger.error("eBay API error %s at %s: %s", resp.status_code, url, resp.text[:500])
            return None
        return resp.json()

    async def _get_inventory_items(self, access_token: str) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        offset = 0
        while True:
            data = await self._get_json(
                access_token,
                f"{self.api_base}/sell/inventory/v1/inventory_item",
                {"limit": _PAGE_SIZE, "offset": offset},
            )
            if not data:
                break
            batch = data.get("inventoryItems", []) or []
            results.extend(batch)
            total = int(data.get("total", len(results)))
            offset += len(batch)
            if not batch or offset >= total:
                break
            await asyncio.sleep(_RATE_LIMIT_SLEEP)
        return results

    async def _get_offer_price(self, access_token: str, sku: str) -> Optional[Decimal]:
        """Best-effort: read the published offer price for a SKU."""
        data = await self._get_json(
            access_token,
            f"{self.api_base}/sell/inventory/v1/offer",
            {"sku": sku},
        )
        if not data:
            return None
        offers = data.get("offers", []) or []
        for offer in offers:
            price = (offer.get("pricingSummary") or {}).get("price") or {}
            if price.get("value") is not None:
                return self._safe_decimal(price["value"])
        return None

    async def _get_orders(self, access_token: str) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        offset = 0
        while True:
            data = await self._get_json(
                access_token,
                f"{self.api_base}/sell/fulfillment/v1/order",
                {"limit": _ORDER_PAGE_SIZE, "offset": offset},
            )
            if not data:
                break
            batch = data.get("orders", []) or []
            results.extend(batch)
            total = int(data.get("total", len(results)))
            offset += len(batch)
            if not batch or offset >= total:
                break
            await asyncio.sleep(_RATE_LIMIT_SLEEP)
        return results

    @property
    def trading_url(self) -> str:
        if self._sandbox:
            return "https://api.sandbox.ebay.com/ws/api.dll"
        return "https://api.ebay.com/ws/api.dll"

    async def _get_seller_hub_listings(self, access_token: str) -> list[dict[str, Any]]:
        """Active listings made in Seller Hub or the eBay app (Trading API).

        The Inventory API only returns listings created through it, so most
        sellers' existing listings are only visible here.
        """
        results: list[dict[str, Any]] = []
        page = 1
        headers = {
            "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
            "X-EBAY-API-SITEID": "0",
            "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
            "X-EBAY-API-IAF-TOKEN": access_token,
            "Content-Type": "text/xml",
        }
        async with httpx.AsyncClient(timeout=30, transport=self.transport) as client:
            while True:
                body = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
                    "<ActiveList><Include>true</Include><Pagination>"
                    f"<EntriesPerPage>{_LISTING_PAGE_SIZE}</EntriesPerPage><PageNumber>{page}</PageNumber>"
                    "</Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>"
                    "</GetMyeBaySellingRequest>"
                )
                try:
                    resp = await client.post(self.trading_url, content=body, headers=headers)
                except httpx.HTTPError as exc:
                    logger.error("eBay Trading API request failed: %s", exc)
                    break
                if resp.status_code != 200:
                    logger.error("eBay Trading API error %s: %s", resp.status_code, resp.text[:500])
                    break
                listings, total_pages = self._parse_my_ebay_selling(resp.text)
                results.extend(listings)
                if page >= total_pages:
                    break
                page += 1
                await asyncio.sleep(_RATE_LIMIT_SLEEP)
        return results

    @classmethod
    def _parse_my_ebay_selling(cls, xml_text: str) -> tuple[list[dict[str, Any]], int]:
        """Parse a GetMyeBaySelling response into (listings, total_pages)."""
        # eBay never sends a DTD; refuse one rather than expand entities.
        if "<!DOCTYPE" in xml_text or "<!ENTITY" in xml_text:
            logger.error("eBay Trading API response contained a DTD; ignoring")
            return [], 0
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            logger.error("eBay Trading API returned unparseable XML")
            return [], 0
        ack = root.findtext("e:Ack", default="", namespaces=_TRADING_NS)
        if ack not in ("Success", "Warning"):
            msg = root.findtext("e:Errors/e:LongMessage", default="", namespaces=_TRADING_NS)
            logger.error("eBay GetMyeBaySelling failed: %s %s", ack, msg)
            return [], 0
        active = root.find("e:ActiveList", _TRADING_NS)
        if active is None:
            return [], 0
        pages_text = active.findtext("e:PaginationResult/e:TotalNumberOfPages", default="1", namespaces=_TRADING_NS)
        total_pages = int(pages_text) if pages_text.isdigit() else 1
        listings: list[dict[str, Any]] = []
        for node in active.findall("e:ItemArray/e:Item", _TRADING_NS):
            def text(path: str) -> str:
                return (node.findtext(path, default="", namespaces=_TRADING_NS) or "").strip()
            item_id = text("e:ItemID")
            if not item_id:
                continue
            available = text("e:QuantityAvailable") or text("e:Quantity") or "0"
            price = text("e:SellingStatus/e:CurrentPrice") or text("e:BuyItNowPrice")
            listings.append({
                "item_id": item_id,
                "sku": text("e:SKU"),
                "title": text("e:Title") or "eBay Item",
                "price": cls._safe_decimal(price) if price else None,
                "quantity": int(available) if available.isdigit() else 0,
                "image": text("e:PictureDetails/e:GalleryURL") or None,
            })
        return listings, max(total_pages, 1)

    # ── Upsert logic ──────────────────────────────────────────────────────────────

    @staticmethod
    def _safe_decimal(value: Any, default: str = "0.00") -> Decimal:
        try:
            return Decimal(str(value))
        except Exception:
            return Decimal(default)

    def _upsert_inventory_item(
        self,
        db: Session,
        user_id: uuid.UUID,
        eb_item: dict,
        sell_price: Optional[Decimal],
        item_sku: Optional[str] = None,
    ) -> tuple[Optional[InventoryItem], bool]:
        """Insert/update an InventoryItem from an eBay inventory_item record.

        eBay inventory items are keyed by SKU, so the external link/id uses the SKU.
        Returns (item, created); (None, False) when the linked item was soft-deleted.
        """
        sku = str(eb_item.get("sku", "")).strip()
        if not sku:
            return None, False
        # `sku` is the link key; the item's visible SKU can differ (Seller Hub
        # listings without a SKU are keyed "listing:<ItemID>").
        shown_sku = sku if item_sku is None else (item_sku or None)
        now = datetime.now(timezone.utc)

        product = eb_item.get("product") or {}
        name = product.get("title") or eb_item.get("sku") or "eBay Item"
        image_urls = product.get("imageUrls") or []
        photo_front = image_urls[0] if image_urls else None
        upc_list = product.get("upc") or []
        upc = upc_list[0] if isinstance(upc_list, list) and upc_list else None

        availability = eb_item.get("availability") or {}
        ship_avail = availability.get("shipToLocationAvailability") or {}
        new_qty = int(ship_avail.get("quantity", 0) or 0)

        link = (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.user_id == user_id,
                InventoryExternalLink.provider == "ebay",
                InventoryExternalLink.external_id == sku,
            )
            .one_or_none()
        )

        item: Optional[InventoryItem] = None
        if link:
            item = (
                db.query(InventoryItem)
                .filter(
                    InventoryItem.id == link.inventory_item_id,
                    InventoryItem.deleted_at.is_(None),
                )
                .one_or_none()
            )
            if item is None:
                logger.warning("eBay SKU %s linked to deleted item; skipping", sku)
                return None, False

        if item and link.offer_id:
            # Listed from Resqlo: Resqlo owns name/price/stock and pushes them to
            # eBay (eBay's quantity is only the listed cap), so never pull back.
            link.last_synced_at = now
            db.add(link)
            return item, False

        if item:
            old_qty = item.quantity
            item.name = name
            item.sku = shown_sku
            item.upc = upc or item.upc
            if sell_price is not None:
                item.expected_sell_price = sell_price
            if photo_front:
                item.photo_front_url = photo_front
            db.add(item)

            if new_qty != old_qty:
                item.quantity = new_qty
                db.add(InventoryStockLedger(
                    inventory_item_id=item.id,
                    user_id=user_id,
                    delta_quantity=new_qty - old_qty,
                    quantity_after=new_qty,
                    event_type="sync",
                    source_type="ebay",
                    source_id=sku,
                ))
            link.external_sku = sku
            link.last_synced_at = now
            db.add(link)
            return item, False

        # Create new item + link
        item = InventoryItem(
            user_id=user_id,
            name=name,
            sku=shown_sku,
            upc=upc,
            expected_sell_price=sell_price,
            quantity=new_qty,
            status="listed",
            source="ebay",
            external_id=sku,
            photo_front_url=photo_front,
        )
        db.add(item)
        db.flush()

        db.add(InventoryExternalLink(
            inventory_item_id=item.id,
            user_id=user_id,
            provider="ebay",
            external_id=sku,
            external_sku=sku,
            last_synced_at=now,
        ))

        if new_qty > 0:
            db.add(InventoryStockLedger(
                inventory_item_id=item.id,
                user_id=user_id,
                delta_quantity=new_qty,
                quantity_after=new_qty,
                event_type="import_adjust",
                source_type="ebay",
                source_id=sku,
            ))
        return item, True

    def _upsert_transaction(
        self, db: Session, user_id: uuid.UUID, eb_order: dict
    ) -> tuple[Transaction, bool]:
        order_id = str(eb_order.get("orderId", ""))
        existing = (
            db.query(Transaction)
            .filter(
                Transaction.user_id == user_id,
                Transaction.source == "ebay",
                Transaction.external_reference_id == order_id,
            )
            .one_or_none()
        )

        pricing = eb_order.get("pricingSummary") or {}
        gross = self._safe_decimal((pricing.get("total") or {}).get("value", "0.00"))

        if existing:
            existing.gross_amount = gross
            # Keep eBay fees from the Finances sync (net = gross - fees).
            existing.net_amount = gross - (existing.fee_amount or Decimal("0.00"))
            return existing, False

        txn = Transaction(
            user_id=user_id,
            method="other",
            status="completed",
            gross_amount=gross,
            fee_amount=Decimal("0.00"),
            net_amount=gross,
            external_reference_id=order_id,
            notes=f"eBay order #{order_id}",
            source="ebay",
        )
        db.add(txn)
        return txn, True

    @staticmethod
    def _parse_ts(value: Any) -> Optional[datetime]:
        if not value:
            return None
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None

    def _apply_order_stock(
        self, db: Session, user_id: uuid.UUID, eb_order: dict, run: Optional[ProviderSyncRun] = None
    ) -> int:
        """Deduct Resqlo stock for each line of an eBay order, exactly once.

        Idempotent via the ledger key ``ebay:order:{orderId}:{lineItemId}``, so
        re-syncs and notification replays never double-deduct. Skips cancelled
        orders and orders placed before the item was linked (the imported
        quantity already reflects those). Returns the number of lines deducted.
        """
        from app.services.inventory import deduct_stock

        order_id = str(eb_order.get("orderId", ""))
        if not order_id:
            return 0
        cancel_state = ((eb_order.get("cancelStatus") or {}).get("cancelState") or "").upper()
        if cancel_state == "CANCELED":
            return 0
        created_at = self._parse_ts(eb_order.get("creationDate"))
        deducted = 0
        for line in eb_order.get("lineItems") or []:
            sku = str(line.get("sku") or "").strip()
            legacy_id = str(line.get("legacyItemId") or "").strip()
            line_id = str(line.get("lineItemId") or "").strip()
            qty = int(line.get("quantity") or 1)
            # Seller Hub listings without a SKU are linked by listing ID.
            link_keys = [k for k in (sku, f"listing:{legacy_id}" if legacy_id else "") if k]
            if not link_keys or not line_id or qty < 1:
                continue
            link = None
            for link_key in link_keys:
                link = (
                    db.query(InventoryExternalLink)
                    .filter(
                        InventoryExternalLink.user_id == user_id,
                        InventoryExternalLink.provider == "ebay",
                        InventoryExternalLink.external_id == link_key,
                    )
                    .one_or_none()
                )
                if link:
                    break
            if not link:
                continue
            sku = link.external_id
            if created_at and link.created_at and created_at < link.created_at:
                continue
            item = (
                db.query(InventoryItem)
                .filter(InventoryItem.id == link.inventory_item_id, InventoryItem.deleted_at.is_(None))
                .one_or_none()
            )
            if item is None:
                continue
            key = f"ebay:order:{order_id}:{line_id}"
            exists = db.query(InventoryStockLedger.id).filter(InventoryStockLedger.idempotency_key == key).first()
            if exists:
                continue
            try:
                deduct_stock(db, item, qty, event_type="sale", source_type="ebay", source_id=order_id, idempotency_key=key)
            except HTTPException:
                # Sold on eBay but Resqlo has no stock left: a double-sell. Flag it.
                logger.warning("eBay order %s oversells item %s", order_id, item.id)
                self.record_issue(
                    db, user_id, issue_type="stock_drift", severity="error", run=run,
                    inventory_item_id=item.id, external_id=sku,
                    details={"reason": "oversold", "ebay_order_id": order_id, "quantity": qty},
                )
                continue
            deducted += 1
            if link.offer_id and link.listed_quantity is not None:
                link.listed_quantity = max(link.listed_quantity - qty, 0)
                if link.listed_quantity == 0:
                    link.listing_status = "sold"
                db.add(link)
        return deducted

    # ── Sync ────────────────────────────────────────────────────────────────────

    async def _do_sync(
        self, db: Session, user_id: uuid.UUID, run: ProviderSyncRun
    ) -> SyncResult:
        token = self.get_token(db, user_id)
        if not token:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Connect eBay first.")
        token = await self._ensure_valid_token(db, token)
        access_token = decrypt_token(token.access_token)

        result = SyncResult(run_id=run.id)

        # Orders first: deduct stock for new sales before item quantities are
        # reconciled, so an eBay sale is never counted twice.
        # --- Orders / transactions ---
        eb_orders = await self._get_orders(access_token)
        new_orders: list[dict] = []
        for eb_order in eb_orders:
            _, created = self._upsert_transaction(db, user_id, eb_order)
            self._apply_order_stock(db, user_id, eb_order, run)
            if created:
                result.transactions_imported += 1
                new_orders.append(eb_order)
            else:
                result.transactions_updated += 1
        db.commit()
        if new_orders:
            await notify_ebay_sales(db, user_id, new_orders)
        logger.info(
            "eBay order sync: %d imported, %d updated for user %s",
            result.transactions_imported, result.transactions_updated, user_id,
        )

        # --- Inventory items ---
        eb_items = await self._get_inventory_items(access_token)
        for eb_item in eb_items:
            sku = str(eb_item.get("sku", "")).strip()
            sell_price = await self._get_offer_price(access_token, sku) if sku else None
            item, created = self._upsert_inventory_item(db, user_id, eb_item, sell_price)
            if item is None:
                self.record_issue(
                    db, user_id, issue_type="stale_link", severity="warning",
                    run=run, external_id=sku,
                    details={"ebay_title": (eb_item.get("product") or {}).get("title")},
                )
                result.items_skipped += 1
                result.errors_count += 1
                continue
            if created:
                result.items_imported += 1
            else:
                result.items_updated += 1
            await asyncio.sleep(_RATE_LIMIT_SLEEP)
        db.commit()

        # --- Seller Hub listings (invisible to the Inventory API) ---
        inventory_skus = {str(i.get("sku", "")).strip() for i in eb_items}
        for listing in await self._get_seller_hub_listings(access_token):
            if listing["sku"] and listing["sku"] in inventory_skus:
                continue  # already synced through the Inventory API above
            key = listing["sku"] or f"listing:{listing['item_id']}"
            eb_item = {
                "sku": key,
                "product": {"title": listing["title"], "imageUrls": [listing["image"]] if listing["image"] else []},
                "availability": {"shipToLocationAvailability": {"quantity": listing["quantity"]}},
            }
            item, created = self._upsert_inventory_item(
                db, user_id, eb_item, listing["price"], item_sku=listing["sku"],
            )
            if item is None:
                result.items_skipped += 1
                continue
            if created:
                result.items_imported += 1
            else:
                result.items_updated += 1
        db.commit()
        logger.info(
            "eBay item sync: %d imported, %d updated, %d skipped for user %s",
            result.items_imported, result.items_updated, result.items_skipped, user_id,
        )

        return result


ebay_service = EbayService()
