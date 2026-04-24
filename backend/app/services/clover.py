"""Clover inventory import adapter.

Architecture decisions:
  - Provider identity key: Clover Item.id (stable UUID per merchant item)
  - One InventoryExternalLink row per item, provider="clover"
  - Quantity source: item.itemStock.quantity from GET /v3/merchants/{mid}/items
    expanded with itemStock. Items without itemStock have qty=0.
  - Phase 1: flat items only. Modifier groups / variants are out of scope.
    Each Clover Item maps 1:1 to one Vendora InventoryItem.
  - No OAuth in this phase: developer tokens or server tokens stored directly
    in CloverCredential via POST /integrations/clover/connect.
  - Transactions are out of scope for import-only phase.

Clover REST API v3 references:
  GET /v3/merchants/{mid}/items
      ?expand=categories,itemStock
      &limit=100
      &offset=N

Response shape (per item):
  {
    "id": "ABCD1234",                  <- stable item ID (external_id)
    "name": "Blue T-Shirt",
    "price": 2500,                     <- integer cents
    "sku": "SKU-001",                  <- may be absent / null
    "itemStock": {
        "quantity": 10.0               <- float, treated as int(floor)
    },
    "categories": {
        "elements": [{"name": "Apparel"}]
    }
  }

Quantity notes:
  - Clover returns itemStock.quantity as a float ("10.0").
  - Only items with itemStock present have tracked stock; others default to 0.
  - price is always an integer (cents), even for $0.00 items.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import ClassVar, Optional
import uuid

import httpx
from sqlalchemy.orm import Session

from app.models.clover import CloverCredential
from app.models.inventory import InventoryExternalLink, InventoryItem, InventoryStockLedger
from app.security.token_encryption import decrypt_token, encrypt_token
from app.services.providers.base import ProviderAdapter, SyncResult

logger = logging.getLogger(__name__)

_CLOVER_BASE = "https://api.clover.com"
_PAGE_SIZE = 100


class CloverService(ProviderAdapter):
    """Import-only Clover adapter.

    Lifecycle (via ProviderAdapter.sync template):
      1. Fetch all items from GET /v3/merchants/{mid}/items (paginated).
         Each request expands categories and itemStock in one call.
      2. Upsert each item into the canonical InventoryItem / ExternalLink tables.
      3. Write stock ledger entries on create (import_adjust) or qty change (sync).
      4. Emit ReconciliationIssue for malformed, stale, or conflicting items.
    """

    provider: ClassVar[str] = "clover"

    # ── ProviderAdapter interface ─────────────────────────────────────────────

    def is_connected(self, db: Session, user_id: uuid.UUID) -> bool:
        return self._get_credential(db, user_id) is not None

    def get_connection_id(self, db: Session, user_id: uuid.UUID) -> Optional[str]:
        cred = self._get_credential(db, user_id)
        return cred.merchant_id if cred else None

    # ── Credential management ─────────────────────────────────────────────────

    def _get_credential(self, db: Session, user_id: uuid.UUID) -> Optional[CloverCredential]:
        return (
            db.query(CloverCredential)
            .filter(CloverCredential.user_id == user_id)
            .one_or_none()
        )

    def store_credential(
        self,
        db: Session,
        *,
        user_id: uuid.UUID,
        merchant_id: str,
        access_token: str,
    ) -> CloverCredential:
        """Upsert Clover credentials for a user."""
        cred = self._get_credential(db, user_id)
        if cred:
            cred.merchant_id = merchant_id
            cred.access_token = encrypt_token(access_token)
        else:
            cred = CloverCredential(
                user_id=user_id,
                merchant_id=merchant_id,
                access_token=encrypt_token(access_token),
            )
            db.add(cred)
        db.commit()
        db.refresh(cred)
        return cred

    # ── Clover API helpers ────────────────────────────────────────────────────

    def _auth_headers(self, access_token: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }

    async def _fetch_items(self, access_token: str, merchant_id: str) -> list[dict]:
        """Fetch all inventory items with offset pagination.

        Expands categories and itemStock in a single request per page to
        minimize API round-trips.

        Returns a flat list of Clover item dicts.
        """
        results: list[dict] = []
        offset = 0
        headers = self._auth_headers(access_token)
        url = f"{_CLOVER_BASE}/v3/merchants/{merchant_id}/items"

        async with httpx.AsyncClient(timeout=30) as client:
            while True:
                resp = await client.get(
                    url,
                    headers=headers,
                    params={
                        "expand": "categories,itemStock",
                        "limit": _PAGE_SIZE,
                        "offset": offset,
                    },
                )
                if resp.status_code >= 400:
                    logger.error(
                        "Clover items API error %s: %s", resp.status_code, resp.text[:500]
                    )
                    break
                data = resp.json()
                elements: list[dict] = data.get("elements", [])
                results.extend(elements)
                if len(elements) < _PAGE_SIZE:
                    break
                offset += len(elements)

        return results

    # ── Item upsert ───────────────────────────────────────────────────────────

    @staticmethod
    def _safe_price(amount_cents: object) -> Optional[Decimal]:
        """Convert Clover price (integer cents) to Decimal dollars."""
        try:
            cents = int(amount_cents)
            return Decimal(cents) / Decimal("100")
        except (TypeError, ValueError, InvalidOperation):
            return None

    @staticmethod
    def _extract_qty(item: dict) -> int:
        """Extract stock quantity from item.itemStock.quantity.

        Clover returns a float string ("10.0") or float.  Items without
        itemStock have no tracked stock; we default to 0.
        """
        item_stock = item.get("itemStock")
        if not item_stock:
            return 0
        try:
            return int(float(item_stock.get("quantity", 0)))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _extract_category(item: dict) -> Optional[str]:
        """Return first category name from item.categories.elements, or None."""
        cats = item.get("categories")
        if not cats:
            return None
        elements = cats.get("elements") or []
        return elements[0].get("name") or None if elements else None

    def _upsert_item(
        self,
        db: Session,
        user_id: uuid.UUID,
        clover_item: dict,
        run: object,
    ) -> tuple[Optional[InventoryItem], bool]:
        """Insert or update a canonical InventoryItem from a Clover item dict.

        Lookup order:
          1. InventoryExternalLink (provider=clover, external_id=item.id)

        On create:
          - Creates InventoryItem + InventoryExternalLink.
          - Writes an 'import_adjust' ledger entry (idempotent key).

        On update:
          - Rewrites name / sku / category / price.
          - Writes a 'sync' ledger entry only if quantity changed.

        Returns (item, created).
        Returns (None, False) for malformed items (no id) or stale links
        (linked item soft-deleted); caller records reconciliation issues.
        """
        item_id: str = (clover_item.get("id") or "").strip()
        name: str = (clover_item.get("name") or "").strip()

        if not item_id:
            self.record_issue(
                db,
                user_id,
                "import_error",
                "warning",
                run=run,
                details={
                    "reason": "Clover item missing id",
                    "raw": str(clover_item)[:300],
                },
            )
            return None, False

        if not name:
            self.record_issue(
                db,
                user_id,
                "import_error",
                "warning",
                run=run,
                external_id=item_id,
                details={"reason": "Clover item has empty name", "item_id": item_id},
            )
            return None, False

        sku: Optional[str] = clover_item.get("sku") or None
        price: Optional[Decimal] = self._safe_price(clover_item.get("price"))
        qty: int = self._extract_qty(clover_item)
        category: Optional[str] = self._extract_category(clover_item)
        now = datetime.now(timezone.utc)

        # ── Primary lookup via InventoryExternalLink ──────────────────────────
        link = (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.user_id == user_id,
                InventoryExternalLink.provider == "clover",
                InventoryExternalLink.external_id == item_id,
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
                # Linked item was soft-deleted — record stale link and skip
                logger.warning(
                    "Clover item %s linked to deleted InventoryItem; skipping", item_id
                )
                self.record_issue(
                    db,
                    user_id,
                    "stale_link",
                    "warning",
                    run=run,
                    external_id=item_id,
                    details={
                        "clover_item_id": item_id,
                        "reason": "linked item soft-deleted",
                    },
                )
                return None, False

        if item:
            # ── Update existing item ──────────────────────────────────────────
            old_qty = item.quantity
            item.name = name
            if sku:
                item.sku = sku
            if category:
                item.category = category
            item.expected_sell_price = price
            db.add(item)

            if qty != old_qty:
                item.quantity = qty
                db.add(
                    InventoryStockLedger(
                        inventory_item_id=item.id,
                        user_id=user_id,
                        delta_quantity=qty - old_qty,
                        quantity_after=qty,
                        event_type="sync",
                        source_type="clover",
                        source_id=item_id,
                    )
                )

            link.external_sku = sku
            link.last_synced_at = now
            db.add(link)

            return item, False

        # ── Create new item + link ────────────────────────────────────────────
        item = InventoryItem(
            user_id=user_id,
            name=name,
            sku=sku,
            category=category,
            expected_sell_price=price,
            quantity=qty,
            status="in_stock",
            source="clover",
            external_id=item_id,
        )
        db.add(item)
        db.flush()  # populate item.id before creating related rows

        db.add(
            InventoryExternalLink(
                inventory_item_id=item.id,
                user_id=user_id,
                provider="clover",
                external_id=item_id,
                external_sku=sku,
                last_synced_at=now,
            )
        )

        # Ledger entry for the initial stock import (idempotent across syncs)
        if qty > 0:
            db.add(
                InventoryStockLedger(
                    inventory_item_id=item.id,
                    user_id=user_id,
                    delta_quantity=qty,
                    quantity_after=qty,
                    event_type="import_adjust",
                    source_type="clover",
                    source_id=item_id,
                    idempotency_key=f"clover:import:{item_id}",
                )
            )

        return item, True

    # ── ProviderAdapter._do_sync ──────────────────────────────────────────────

    async def _do_sync(
        self, db: Session, user_id: uuid.UUID, run: object
    ) -> SyncResult:
        """Pull Clover items into canonical Vendora inventory.

        Step 1: Fetch all items (paginated) with stock + category expansions.
        Step 2: Upsert each item into canonical inventory tables.
        """
        cred = self._get_credential(db, user_id)
        if cred is None:
            raise RuntimeError(
                f"Clover credentials not found for user {user_id}. "
                "Call POST /integrations/clover/connect first."
            )

        result = SyncResult(run_id=run.id)  # type: ignore[attr-defined]

        # ── Step 1: Fetch items ───────────────────────────────────────────────
        clover_items = await self._fetch_items(decrypt_token(cred.access_token), cred.merchant_id)

        # ── Step 2: Upsert ────────────────────────────────────────────────────
        for clover_item in clover_items:
            item_id = clover_item.get("id", "<unknown>")
            try:
                item, created = self._upsert_item(db, user_id, clover_item, run)
                if item is None:
                    result.items_skipped += 1
                    result.errors_count += 1
                elif created:
                    result.items_imported += 1
                else:
                    result.items_updated += 1
            except Exception as exc:
                logger.error(
                    "Clover: unhandled error upserting item %s: %s", item_id, exc
                )
                self.record_issue(
                    db,
                    user_id,
                    "import_error",
                    "error",
                    run=run,
                    external_id=str(item_id) if item_id else None,
                    details={"error": str(exc)[:500]},
                )
                result.errors_count += 1

        return result


# Module-level singleton — matches the lightspeed_service / square_service pattern
clover_service = CloverService()
