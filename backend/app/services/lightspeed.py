"""Lightspeed Retail (R-Series) integration — OAuth + one-way sync."""
from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional
import uuid
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.config import settings
from app.models.integration import LightspeedToken
from app.models.inventory import InventoryItem
from app.models.transaction import Transaction

logger = logging.getLogger(__name__)

_LS_API_BASE = "https://api.lightspeedapp.com/API/V3/Account/{account_id}"
_PAGE_SIZE = 100
_RATE_LIMIT_SLEEP = 1.1  # seconds between pages to stay under 60 req/min


class LightspeedService:
    AUTH_URL = "https://cloud.lightspeedapp.com/oauth/authorize.php"
    TOKEN_URL = "https://cloud.lightspeedapp.com/oauth/access_token.php"

    def __init__(self) -> None:
        self.client_id = settings.LIGHTSPEED_CLIENT_ID
        self.client_secret = settings.LIGHTSPEED_CLIENT_SECRET
        self.redirect_uri = settings.LIGHTSPEED_REDIRECT_URI

    # ------------------------------------------------------------------ #
    # OAuth helpers
    # ------------------------------------------------------------------ #

    def _assert_configured(self) -> None:
        if not (self.client_id and self.client_secret and self.redirect_uri):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Lightspeed integration is not configured yet.",
            )

    def build_state(self, user_id: uuid.UUID) -> str:
        nonce = secrets.token_urlsafe(8)
        return f"{user_id}:{nonce}"

    def parse_state(self, state: str) -> uuid.UUID:
        try:
            user_id_str = state.split(":", 1)[0]
            return uuid.UUID(user_id_str)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid Lightspeed state parameter",
            ) from exc

    def authorization_url(self, state: str, scope: str = "employee:all inventory:all") -> str:
        self._assert_configured()
        params = urlencode(
            {
                "response_type": "code",
                "client_id": self.client_id,
                "redirect_uri": self.redirect_uri,
                "scope": scope,
                "state": state,
            }
        )
        return f"{self.AUTH_URL}?{params}"

    async def exchange_authorization_code(self, code: str) -> dict:
        self._assert_configured()
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                self.TOKEN_URL,
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "code": code,
                    "grant_type": "authorization_code",
                    "redirect_uri": self.redirect_uri,
                },
            )
        if resp.status_code >= 400:
            raise HTTPException(resp.status_code, detail="Lightspeed token exchange failed")
        payload = resp.json()
        payload["expires_at"] = datetime.now(timezone.utc) + timedelta(
            seconds=payload.get("expires_in", 1800)
        )
        return payload

    async def _refresh_access_token(self, db: Session, token: LightspeedToken) -> LightspeedToken:
        """Exchange the refresh_token for a new access_token and persist it."""
        self._assert_configured()
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                self.TOKEN_URL,
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "refresh_token": token.refresh_token,
                    "grant_type": "refresh_token",
                },
            )
        if resp.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Lightspeed token refresh failed — please reconnect.",
            )
        payload = resp.json()
        token.access_token = payload["access_token"]
        token.expires_at = datetime.now(timezone.utc) + timedelta(
            seconds=payload.get("expires_in", 1800)
        )
        if payload.get("refresh_token"):
            token.refresh_token = payload["refresh_token"]
        db.commit()
        db.refresh(token)
        logger.info("Lightspeed token refreshed for user %s", token.user_id)
        return token

    async def _ensure_valid_token(self, db: Session, token: LightspeedToken) -> LightspeedToken:
        """Refresh access token if it expires within 5 minutes."""
        buffer = timedelta(minutes=5)
        if token.expires_at - datetime.now(timezone.utc) < buffer:
            token = await self._refresh_access_token(db, token)
        return token

    # ------------------------------------------------------------------ #
    # Token CRUD
    # ------------------------------------------------------------------ #

    def upsert_token(
        self,
        db: Session,
        *,
        user_id: uuid.UUID,
        account_id: str,
        access_token: str,
        refresh_token: str,
        expires_at: datetime,
        scopes: Optional[str] = None,
    ) -> LightspeedToken:
        token = db.query(LightspeedToken).filter(LightspeedToken.user_id == user_id).one_or_none()
        if token:
            token.account_id = account_id
            token.access_token = access_token
            token.refresh_token = refresh_token
            token.expires_at = expires_at
            token.scopes = scopes
        else:
            token = LightspeedToken(
                user_id=user_id,
                account_id=account_id,
                access_token=access_token,
                refresh_token=refresh_token,
                expires_at=expires_at,
                scopes=scopes,
            )
            db.add(token)
        db.commit()
        db.refresh(token)
        return token

    def get_token(self, db: Session, user_id: uuid.UUID) -> Optional[LightspeedToken]:
        return (
            db.query(LightspeedToken)
            .filter(LightspeedToken.user_id == user_id)
            .one_or_none()
        )

    # ------------------------------------------------------------------ #
    # Lightspeed API helpers
    # ------------------------------------------------------------------ #

    def _base_url(self, account_id: str) -> str:
        return _LS_API_BASE.format(account_id=account_id)

    async def _get_all_pages(
        self, access_token: str, url: str, root_key: str
    ) -> list[dict[str, Any]]:
        """Paginate through a Lightspeed collection endpoint."""
        results: list[dict[str, Any]] = []
        offset = 0
        headers = {"Authorization": f"Bearer {access_token}"}
        async with httpx.AsyncClient(timeout=30) as client:
            while True:
                resp = await client.get(
                    url,
                    headers=headers,
                    params={
                        "limit": _PAGE_SIZE,
                        "offset": offset,
                        "load_relations": '["Category","Prices"]' if root_key == "Item" else '["SaleLines"]',
                    },
                )
                if resp.status_code == 429:
                    logger.warning("Lightspeed rate limit hit, sleeping 60s")
                    await asyncio.sleep(60)
                    continue
                if resp.status_code >= 400:
                    logger.error("Lightspeed API error %s: %s", resp.status_code, resp.text)
                    break
                data = resp.json()
                batch = data.get(root_key, [])
                if isinstance(batch, dict):
                    batch = [batch]
                results.extend(batch)
                # Lightspeed returns "@attributes.count" to tell total available
                attrs = data.get("@attributes", {})
                total = int(attrs.get("count", len(batch)))
                offset += len(batch)
                if offset >= total or not batch:
                    break
                await asyncio.sleep(_RATE_LIMIT_SLEEP)
        return results

    # ------------------------------------------------------------------ #
    # Sync logic
    # ------------------------------------------------------------------ #

    @staticmethod
    def _safe_decimal(value: Any, default: str = "0.00") -> Decimal:
        try:
            return Decimal(str(value))
        except Exception:
            return Decimal(default)

    def _upsert_inventory_item(
        self, db: Session, user_id: uuid.UUID, ls_item: dict
    ) -> tuple[InventoryItem, bool]:
        """Insert or update an inventory item from a Lightspeed Item record.

        Returns (item, created).
        """
        external_id = str(ls_item.get("itemID", ""))
        existing = (
            db.query(InventoryItem)
            .filter(
                InventoryItem.user_id == user_id,
                InventoryItem.source == "lightspeed",
                InventoryItem.external_id == external_id,
            )
            .one_or_none()
        )

        # Prices — take the "Default" price or first available
        prices = ls_item.get("Prices", {}).get("ItemPrice", [])
        if isinstance(prices, dict):
            prices = [prices]
        sell_price: Optional[Decimal] = None
        for p in prices:
            if p.get("useType") == "Default":
                sell_price = self._safe_decimal(p.get("amount"))
                break
        if sell_price is None and prices:
            sell_price = self._safe_decimal(prices[0].get("amount"))

        category_name: Optional[str] = None
        cat = ls_item.get("Category")
        if isinstance(cat, dict):
            category_name = cat.get("name") or None

        buy_price = self._safe_decimal(ls_item.get("defaultCost", "0.00"))

        if existing:
            existing.name = ls_item.get("description", existing.name)
            existing.sku = ls_item.get("systemSku") or existing.sku
            existing.upc = ls_item.get("upc") or existing.upc
            existing.category = category_name or existing.category
            existing.buy_price = buy_price
            existing.expected_sell_price = sell_price
            return existing, False

        item = InventoryItem(
            user_id=user_id,
            name=ls_item.get("description") or "Unnamed Item",
            sku=ls_item.get("systemSku") or None,
            upc=ls_item.get("upc") or None,
            category=category_name,
            buy_price=buy_price,
            expected_sell_price=sell_price,
            status="in_stock",
            source="lightspeed",
            external_id=external_id,
        )
        db.add(item)
        return item, True

    def _upsert_transaction(
        self, db: Session, user_id: uuid.UUID, ls_sale: dict
    ) -> tuple[Transaction, bool]:
        """Insert or update a transaction from a Lightspeed Sale record.

        Returns (txn, created).
        """
        sale_id = str(ls_sale.get("saleID", ""))
        existing = (
            db.query(Transaction)
            .filter(
                Transaction.user_id == user_id,
                Transaction.source == "lightspeed",
                Transaction.external_reference_id == sale_id,
            )
            .one_or_none()
        )

        gross = self._safe_decimal(ls_sale.get("total", "0.00"))
        tax = self._safe_decimal(ls_sale.get("totalTax", "0.00"))
        net = gross - tax

        if existing:
            existing.gross_amount = gross
            existing.net_amount = net
            return existing, False

        txn = Transaction(
            user_id=user_id,
            method="other",
            status="completed",
            gross_amount=gross,
            fee_amount=Decimal("0.00"),
            net_amount=net,
            external_reference_id=sale_id,
            notes=f"Lightspeed sale #{sale_id}",
            source="lightspeed",
        )
        db.add(txn)
        return txn, True

    async def sync(self, db: Session, user_id: uuid.UUID) -> dict[str, int]:
        """Run a full one-way sync: Lightspeed → Vendora.

        Returns {"items_imported": N, "transactions_imported": M}.
        """
        token = self.get_token(db, user_id)
        if not token:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Connect Lightspeed first.",
            )

        token = await self._ensure_valid_token(db, token)
        base = self._base_url(token.account_id)

        # --- Inventory Items ---
        ls_items = await self._get_all_pages(token.access_token, f"{base}/Item.json", "Item")
        items_created = items_updated = 0
        for ls_item in ls_items:
            _, created = self._upsert_inventory_item(db, user_id, ls_item)
            if created:
                items_created += 1
            else:
                items_updated += 1
        db.commit()
        logger.info(
            "Lightspeed item sync: %d created, %d updated for user %s",
            items_created,
            items_updated,
            user_id,
        )

        # --- Sales / Transactions ---
        ls_sales = await self._get_all_pages(token.access_token, f"{base}/Sale.json", "Sale")
        txns_created = txns_updated = 0
        for ls_sale in ls_sales:
            _, created = self._upsert_transaction(db, user_id, ls_sale)
            if created:
                txns_created += 1
            else:
                txns_updated += 1
        db.commit()
        logger.info(
            "Lightspeed sale sync: %d created, %d updated for user %s",
            txns_created,
            txns_updated,
            user_id,
        )

        return {
            "items_imported": items_created,
            "items_updated": items_updated,
            "transactions_imported": txns_created,
            "transactions_updated": txns_updated,
        }


lightspeed_service = LightspeedService()
