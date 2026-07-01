"""Lightspeed Retail (R-Series) integration — OAuth + one-way sync."""
from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, ClassVar, Optional
import uuid
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, status
import jwt
from jwt.exceptions import InvalidTokenError as JWTError
from sqlalchemy.orm import Session

from app.config import settings
from app.models.integration import LightspeedToken
from app.models.inventory import InventoryItem, InventoryExternalLink, InventoryStockLedger
from app.models.provider import ProviderSyncRun
from app.models.transaction import Transaction
from app.security.token_encryption import decrypt_token, encrypt_token
from app.services.providers.base import ProviderAdapter, SyncResult

logger = logging.getLogger(__name__)

_LS_API_BASE = "https://api.lightspeedapp.com/API/V3/Account/{account_id}"
_PAGE_SIZE = 100
_RATE_LIMIT_SLEEP = 1.1  # seconds between pages to stay under 60 req/min


class LightspeedService(ProviderAdapter):
    AUTH_URL = "https://cloud.lightspeedapp.com/oauth/authorize.php"
    TOKEN_URL = "https://cloud.lightspeedapp.com/oauth/access_token.php"

    provider: ClassVar[str] = "lightspeed"

    def __init__(self) -> None:
        self.client_id = settings.LIGHTSPEED_CLIENT_ID
        self.client_secret = settings.LIGHTSPEED_CLIENT_SECRET
        self.redirect_uri = settings.LIGHTSPEED_REDIRECT_URI

    # ── ProviderAdapter interface ──────────────────────────────────────────────

    def is_connected(self, db: Session, user_id: uuid.UUID) -> bool:
        return self.get_token(db, user_id) is not None

    def get_connection_id(self, db: Session, user_id: uuid.UUID) -> Optional[str]:
        token = self.get_token(db, user_id)
        return token.account_id if token else None

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
        payload = {
            "sub": str(user_id),
            "purpose": "lightspeed_oauth",
            "nonce": secrets.token_urlsafe(16),
            "exp": datetime.now(timezone.utc) + timedelta(minutes=10),
        }
        return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

    def parse_state(self, state: str) -> uuid.UUID:
        try:
            payload = jwt.decode(
                state,
                settings.SECRET_KEY,
                algorithms=[settings.ALGORITHM],
            )
            if payload.get("purpose") != "lightspeed_oauth":
                raise ValueError("invalid state purpose")
            return uuid.UUID(payload["sub"])
        except (JWTError, KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid Lightspeed state parameter",
            ) from exc

    def authorization_url(self, state: str, scope: str = "employee:inventory employee:reports") -> str:
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
                    "refresh_token": decrypt_token(token.refresh_token),
                    "grant_type": "refresh_token",
                },
            )
        if resp.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Lightspeed token refresh failed — please reconnect.",
            )
        payload = resp.json()
        token.access_token = encrypt_token(payload["access_token"])
        token.expires_at = datetime.now(timezone.utc) + timedelta(
            seconds=payload.get("expires_in", 1800)
        )
        if payload.get("refresh_token"):
            token.refresh_token = encrypt_token(payload["refresh_token"])
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
            token.access_token = encrypt_token(access_token)
            token.refresh_token = encrypt_token(refresh_token)
            token.expires_at = expires_at
            token.scopes = scopes
        else:
            token = LightspeedToken(
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

    async def _write_inventory_item(
        self,
        access_token: str,
        url: str,
        item: InventoryItem,
        *,
        create: bool,
    ) -> dict[str, Any]:
        """Create or update a Lightspeed catalog item using documented writable fields."""
        payload = {
            "description": item.name,
            "defaultCost": str(item.buy_price or Decimal("0.00")),
            "customSku": item.sku or "",
            "upc": item.upc or "",
        }
        if item.expected_sell_price is not None:
            payload["Prices"] = {
                "ItemPrice": [{"useType": "Default", "amount": str(item.expected_sell_price)}]
            }
        headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=30) as client:
            response = await (client.post(url, headers=headers, json=payload) if create else client.put(url, headers=headers, json=payload))
        if response.status_code >= 400:
            logger.error("Lightspeed write error %s: %s", response.status_code, response.text)
            raise HTTPException(status_code=502, detail="Lightspeed rejected the inventory update.")
        data = response.json()
        record = data.get("Item", data)
        if not isinstance(record, dict) or not record.get("itemID"):
            raise HTTPException(status_code=502, detail="Lightspeed returned an invalid inventory response.")
        return record

    async def push_item(self, db: Session, user_id: uuid.UUID, item_id: uuid.UUID) -> bool:
        """Publish one Vendora item to Lightspeed; return True when newly created."""
        token = self.get_token(db, user_id)
        if not token:
            raise HTTPException(status_code=404, detail="Connect Lightspeed first.")
        item = db.query(InventoryItem).filter(
            InventoryItem.id == item_id,
            InventoryItem.user_id == user_id,
            InventoryItem.deleted_at.is_(None),
        ).first()
        if not item:
            raise HTTPException(status_code=404, detail="Inventory item not found.")
        token = await self._ensure_valid_token(db, token)
        access_token = decrypt_token(token.access_token)
        base = self._base_url(token.account_id)
        link = db.query(InventoryExternalLink).filter(
            InventoryExternalLink.inventory_item_id == item.id,
            InventoryExternalLink.user_id == user_id,
            InventoryExternalLink.provider == "lightspeed",
        ).first()
        created = link is None
        url = f"{base}/Item.json" if created else f"{base}/Item/{link.external_id}.json"
        record = await self._write_inventory_item(access_token, url, item, create=created)
        if link is None:
            link = InventoryExternalLink(
                inventory_item_id=item.id,
                user_id=user_id,
                provider="lightspeed",
                external_id=str(record["itemID"]),
            )
        link.external_sku = record.get("systemSku") or record.get("customSku") or item.sku
        link.last_synced_at = datetime.now(timezone.utc)
        item.source = item.source or "lightspeed"
        item.external_id = item.external_id or str(record["itemID"])
        db.add_all([item, link])
        db.commit()
        return created

    async def push_linked_items(self, db: Session, user_id: uuid.UUID) -> dict[str, int]:
        """Push all already-linked Vendora catalog records back to Lightspeed."""
        links = db.query(InventoryExternalLink).filter(
            InventoryExternalLink.user_id == user_id,
            InventoryExternalLink.provider == "lightspeed",
        ).all()
        updated = 0
        errors = 0
        for link in links:
            try:
                await self.push_item(db, user_id, link.inventory_item_id)
                updated += 1
            except HTTPException:
                db.rollback()
                errors += 1
        return {"items_updated": updated, "errors_count": errors}

    def disconnect(self, db: Session, user_id: uuid.UUID) -> int:
        """Delete OAuth credentials while retaining record links for safe reconnect."""
        token = self.get_token(db, user_id)
        if token:
            db.delete(token)
            db.commit()
        return db.query(InventoryExternalLink).filter(
            InventoryExternalLink.user_id == user_id,
            InventoryExternalLink.provider == "lightspeed",
        ).count()

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
    ) -> tuple[Optional[InventoryItem], bool]:
        """Insert or update an inventory item from a Lightspeed Item record.

        Lookup order:
          1. Primary: InventoryExternalLink (provider=lightspeed, external_id)
          2. Fallback: InventoryItem.source/external_id (legacy rows pre-patch)

        On update:
          - Rewrites name/sku/upc/category/prices.
          - If quantity changed, writes a 'sync' ledger entry.
          - Ensures InventoryExternalLink exists and stamps last_synced_at.

        On create:
          - Creates InventoryItem + InventoryExternalLink.
          - Writes an 'import_adjust' ledger entry for the initial quantity.

        Returns (item, created).  Returns (None, False) if the linked item
        was soft-deleted (skip without aborting the full sync).
        """
        external_id = str(ls_item.get("itemID", ""))
        now = datetime.now(timezone.utc)

        # Resolve prices -------------------------------------------------------
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
        new_qty = int(ls_item.get("qoh", 1))
        new_sku = ls_item.get("systemSku") or None

        # Primary lookup via InventoryExternalLink -----------------------------
        link = (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.user_id == user_id,
                InventoryExternalLink.provider == "lightspeed",
                InventoryExternalLink.external_id == external_id,
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
                # Linked item was soft-deleted — skip without failing the sync
                logger.warning(
                    "Lightspeed item %s linked to deleted InventoryItem; skipping",
                    external_id,
                )
                return None, False
        else:
            # Fallback: legacy items that stored source/external_id on the item row
            item = (
                db.query(InventoryItem)
                .filter(
                    InventoryItem.user_id == user_id,
                    InventoryItem.source == "lightspeed",
                    InventoryItem.external_id == external_id,
                    InventoryItem.deleted_at.is_(None),
                )
                .one_or_none()
            )

        if item:
            # ── Update existing item ─────────────────────────────────────────
            old_qty = item.quantity
            item.name = ls_item.get("description", item.name)
            item.sku = new_sku or item.sku
            item.upc = ls_item.get("upc") or item.upc
            item.category = category_name or item.category
            item.buy_price = buy_price
            item.expected_sell_price = sell_price
            db.add(item)

            # Write ledger entry only if quantity actually changed
            if new_qty != old_qty:
                item.quantity = new_qty
                db.add(InventoryStockLedger(
                    inventory_item_id=item.id,
                    user_id=user_id,
                    delta_quantity=new_qty - old_qty,
                    quantity_after=new_qty,
                    event_type="sync",
                    source_type="lightspeed",
                    source_id=external_id,
                ))

            # Ensure external link exists (backfill for legacy items)
            if link is None:
                link = InventoryExternalLink(
                    inventory_item_id=item.id,
                    user_id=user_id,
                    provider="lightspeed",
                    external_id=external_id,
                    external_sku=new_sku,
                    last_synced_at=now,
                )
                db.add(link)
            else:
                link.external_sku = new_sku
                link.last_synced_at = now
                db.add(link)

            return item, False

        # ── Create new item + link ───────────────────────────────────────────
        item = InventoryItem(
            user_id=user_id,
            name=ls_item.get("description") or "Unnamed Item",
            sku=new_sku,
            upc=ls_item.get("upc") or None,
            category=category_name,
            buy_price=buy_price,
            expected_sell_price=sell_price,
            quantity=new_qty,
            status="in_stock",
            source="lightspeed",
            external_id=external_id,
        )
        db.add(item)
        db.flush()  # populate item.id before creating related rows

        db.add(InventoryExternalLink(
            inventory_item_id=item.id,
            user_id=user_id,
            provider="lightspeed",
            external_id=external_id,
            external_sku=new_sku,
            last_synced_at=now,
        ))

        # Write initial quantity as an import_adjust ledger entry
        if new_qty > 0:
            db.add(InventoryStockLedger(
                inventory_item_id=item.id,
                user_id=user_id,
                delta_quantity=new_qty,
                quantity_after=new_qty,
                event_type="import_adjust",
                source_type="lightspeed",
                source_id=external_id,
            ))

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

    async def _do_sync(
        self, db: Session, user_id: uuid.UUID, run: ProviderSyncRun
    ) -> SyncResult:
        """Provider-specific sync work.  Called by the ProviderAdapter template sync().

        Pulls items and sales from Lightspeed, upserts into Vendora inventory and
        transactions, writes ledger entries, and records reconciliation issues for
        any stale links encountered.
        """
        token = self.get_token(db, user_id)
        if not token:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Connect Lightspeed first.",
            )

        token = await self._ensure_valid_token(db, token)
        base = self._base_url(token.account_id)

        result = SyncResult(run_id=run.id)

        # --- Inventory Items ---
        ls_items = await self._get_all_pages(decrypt_token(token.access_token), f"{base}/Item.json", "Item")
        for ls_item in ls_items:
            item, created = self._upsert_inventory_item(db, user_id, ls_item)
            if item is None:
                # Linked InventoryItem was soft-deleted — surface as reconciliation issue
                external_id = str(ls_item.get("itemID", ""))
                self.record_issue(
                    db,
                    user_id,
                    issue_type="stale_link",
                    severity="warning",
                    run=run,
                    external_id=external_id,
                    details={"ls_item_description": ls_item.get("description")},
                )
                result.items_skipped += 1
                result.errors_count += 1
                continue
            if created:
                result.items_imported += 1
            else:
                result.items_updated += 1
        db.commit()
        logger.info(
            "Lightspeed item sync: %d created, %d updated, %d skipped for user %s",
            result.items_imported,
            result.items_updated,
            result.items_skipped,
            user_id,
        )

        # --- Sales / Transactions ---
        ls_sales = await self._get_all_pages(decrypt_token(token.access_token), f"{base}/Sale.json", "Sale")
        for ls_sale in ls_sales:
            _, created = self._upsert_transaction(db, user_id, ls_sale)
            if created:
                result.transactions_imported += 1
            else:
                result.transactions_updated += 1
        db.commit()
        logger.info(
            "Lightspeed sale sync: %d created, %d updated for user %s",
            result.transactions_imported,
            result.transactions_updated,
            user_id,
        )

        return result


lightspeed_service = LightspeedService()
