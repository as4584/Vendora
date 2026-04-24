"""Square Catalog + Inventory import adapter.

Architecture decisions:
  - Provider identity key: Square ITEM_VARIATION.id (globally unique per merchant)
  - One InventoryExternalLink row per variation, provider="square"
  - Quantity source: Square Inventory Counts API, state=IN_STOCK
    If location_id is configured on the credential, filter to that location.
    Otherwise sum IN_STOCK quantities across all locations for the variation.
  - No OAuth: Square personal access tokens (or OAuth tokens) are stored directly
    in SquareCredential via POST /integrations/square/connect.
  - Payments: 30-day rolling window via GET /v2/payments.

Square API v2 references used:
  GET  /v2/catalog/list?types=ITEM           — paginated ITEM catalog objects
  POST /v2/inventory/counts/batch-retrieve   — inventory counts by variation IDs
  GET  /v2/payments                          — paginated payment records
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import ClassVar, Optional
import uuid

import httpx
from sqlalchemy.orm import Session

from app.models.inventory import InventoryExternalLink, InventoryItem, InventoryStockLedger
from app.models.square import SquareCredential
from app.models.transaction import Transaction
from app.security.token_encryption import decrypt_token, encrypt_token
from app.services.providers.base import ProviderAdapter, SyncResult

logger = logging.getLogger(__name__)

_SQUARE_BASE = "https://connect.squareup.com"
_SQUARE_VERSION = "2024-01-17"
_CATALOG_BATCH = 100   # max IDs per inventory counts batch request
_INVENTORY_BATCH = 100
_PAYMENTS_DAYS = 30    # rolling window for payment import


class SquareService(ProviderAdapter):
    """Import-only Square adapter.

    Lifecycle (via ProviderAdapter.sync template):
      1. Fetch all ITEM objects from Square Catalog API (paginated).
      2. Collect variation IDs from nested ITEM_VARIATION objects.
      3. Batch-fetch inventory counts for all variation IDs.
      4. Upsert each variation into the canonical InventoryItem / ExternalLink tables.
      5. Write stock ledger entries on create (import_adjust) and qty change (sync).
      6. Emit ReconciliationIssue for malformed, stale, or duplicate variations.
    """

    provider: ClassVar[str] = "square"

    # ── ProviderAdapter interface ─────────────────────────────────────────────

    def is_connected(self, db: Session, user_id: uuid.UUID) -> bool:
        return self._get_credential(db, user_id) is not None

    def get_connection_id(self, db: Session, user_id: uuid.UUID) -> Optional[str]:
        cred = self._get_credential(db, user_id)
        return cred.merchant_id if cred else None

    # ── Credential management ─────────────────────────────────────────────────

    def _get_credential(self, db: Session, user_id: uuid.UUID) -> Optional[SquareCredential]:
        return (
            db.query(SquareCredential)
            .filter(SquareCredential.user_id == user_id)
            .one_or_none()
        )

    def store_credential(
        self,
        db: Session,
        *,
        user_id: uuid.UUID,
        access_token: str,
        merchant_id: Optional[str] = None,
        location_id: Optional[str] = None,
    ) -> SquareCredential:
        """Upsert Square credentials for a user.

        The credential row is unique per user (UNIQUE constraint on user_id).
        """
        cred = self._get_credential(db, user_id)
        if cred:
            cred.access_token = encrypt_token(access_token)
            if merchant_id is not None:
                cred.merchant_id = merchant_id
            if location_id is not None:
                cred.location_id = location_id
        else:
            cred = SquareCredential(
                user_id=user_id,
                access_token=encrypt_token(access_token),
                merchant_id=merchant_id,
                location_id=location_id,
            )
            db.add(cred)
        db.commit()
        db.refresh(cred)
        return cred

    # ── Square API helpers ────────────────────────────────────────────────────

    def _auth_headers(self, access_token: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {access_token}",
            "Square-Version": _SQUARE_VERSION,
            "Content-Type": "application/json",
        }

    async def _fetch_catalog(self, access_token: str) -> list[dict]:
        """Fetch all ITEM-type catalog objects with cursor pagination.

        Returns a flat list of CatalogObject dicts (type=ITEM), each containing
        an ``item_data.variations`` list of ITEM_VARIATION objects.
        """
        results: list[dict] = []
        cursor: Optional[str] = None
        headers = self._auth_headers(access_token)

        async with httpx.AsyncClient(timeout=30, base_url=_SQUARE_BASE) as client:
            while True:
                params: dict = {"types": "ITEM"}
                if cursor:
                    params["cursor"] = cursor
                resp = await client.get("/v2/catalog/list", headers=headers, params=params)
                if resp.status_code >= 400:
                    logger.error(
                        "Square catalog API error %s: %s", resp.status_code, resp.text[:500]
                    )
                    break
                data = resp.json()
                results.extend(data.get("objects", []))
                cursor = data.get("cursor")
                if not cursor:
                    break

        return results

    async def _fetch_inventory_counts(
        self,
        access_token: str,
        variation_ids: list[str],
        location_id: Optional[str],
    ) -> dict[str, int]:
        """Batch-fetch IN_STOCK inventory counts for the supplied variation IDs.

        Returns ``{variation_id: total_in_stock_quantity}``.
        Quantities are summed across locations unless location_id is given.
        """
        if not variation_ids:
            return {}

        qty_map: dict[str, int] = {}
        headers = self._auth_headers(access_token)

        async with httpx.AsyncClient(timeout=30, base_url=_SQUARE_BASE) as client:
            for i in range(0, len(variation_ids), _INVENTORY_BATCH):
                batch_ids = variation_ids[i : i + _INVENTORY_BATCH]
                body: dict = {
                    "catalog_object_ids": batch_ids,
                    "states": ["IN_STOCK"],
                }
                if location_id:
                    body["location_ids"] = [location_id]

                cursor: Optional[str] = None
                while True:
                    if cursor:
                        body["cursor"] = cursor
                    resp = await client.post(
                        "/v2/inventory/counts/batch-retrieve",
                        headers=headers,
                        json=body,
                    )
                    if resp.status_code >= 400:
                        logger.error(
                            "Square inventory API error %s: %s",
                            resp.status_code,
                            resp.text[:500],
                        )
                        break
                    data = resp.json()
                    for count in data.get("counts", []):
                        if count.get("state") != "IN_STOCK":
                            continue
                        vid = count.get("catalog_object_id", "")
                        if not vid:
                            continue
                        try:
                            qty = int(float(count.get("quantity", "0")))
                        except (ValueError, TypeError):
                            qty = 0
                        qty_map[vid] = qty_map.get(vid, 0) + qty
                    cursor = data.get("cursor")
                    if not cursor:
                        break

        return qty_map

    # ── Item upsert ───────────────────────────────────────────────────────────

    @staticmethod
    def _safe_price(amount_cents: object) -> Optional[Decimal]:
        """Convert Square price_money.amount (integer cents) to a Decimal in dollars."""
        try:
            return Decimal(str(int(amount_cents))) / Decimal("100")
        except (InvalidOperation, TypeError, ValueError):
            return None

    def _upsert_item(
        self,
        db: Session,
        user_id: uuid.UUID,
        variation: dict,
        qty: int,
        parent_name: str,
        run: object,
    ) -> tuple[Optional[InventoryItem], bool]:
        """Insert or update a canonical InventoryItem from a Square ITEM_VARIATION.

        Lookup order:
          1. InventoryExternalLink (provider=square, external_id=variation.id)

        On create:
          - Creates InventoryItem + InventoryExternalLink.
          - Writes an 'import_adjust' ledger entry (idempotent key).

        On update:
          - Rewrites name / sku / price.
          - Writes a 'sync' ledger entry only if quantity changed.

        Returns (item, created).
        Returns (None, False) when the variation must be skipped (stale link,
        malformed data); the caller should record a reconciliation issue.
        """
        variation_id: str = variation.get("id", "").strip()
        var_data: dict = variation.get("item_variation_data", {})

        if not variation_id:
            self.record_issue(
                db,
                user_id,
                "import_error",
                "warning",
                run=run,
                details={"reason": "ITEM_VARIATION missing id", "raw": str(variation)[:300]},
            )
            return None, False

        # Build canonical name: "Parent - Variation" or just "Parent" if variation
        # name is empty / default.
        variation_name: str = (var_data.get("name") or "").strip()
        if variation_name and variation_name.lower() != "regular":
            name = f"{parent_name} - {variation_name}"
        else:
            name = parent_name or "Unnamed Item"

        sku: Optional[str] = var_data.get("sku") or None
        price_money: dict = var_data.get("price_money") or {}
        price: Optional[Decimal] = (
            self._safe_price(price_money.get("amount")) if price_money else None
        )

        now = datetime.now(timezone.utc)

        # ── Primary lookup via InventoryExternalLink ──────────────────────────
        link = (
            db.query(InventoryExternalLink)
            .filter(
                InventoryExternalLink.user_id == user_id,
                InventoryExternalLink.provider == "square",
                InventoryExternalLink.external_id == variation_id,
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
                    "Square variation %s linked to deleted InventoryItem; skipping",
                    variation_id,
                )
                self.record_issue(
                    db,
                    user_id,
                    "stale_link",
                    "warning",
                    run=run,
                    external_id=variation_id,
                    details={"variation_id": variation_id, "reason": "linked item soft-deleted"},
                )
                return None, False

        if item:
            # ── Update existing item ──────────────────────────────────────────
            old_qty = item.quantity
            item.name = name
            if sku:
                item.sku = sku
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
                        source_type="square",
                        source_id=variation_id,
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
            expected_sell_price=price,
            quantity=qty,
            status="in_stock",
            source="square",
            external_id=variation_id,
        )
        db.add(item)
        db.flush()  # populate item.id before creating related rows

        db.add(
            InventoryExternalLink(
                inventory_item_id=item.id,
                user_id=user_id,
                provider="square",
                external_id=variation_id,
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
                    source_type="square",
                    source_id=variation_id,
                    idempotency_key=f"square:import:{variation_id}",
                )
            )

        return item, True

    # ── Payments fetch ────────────────────────────────────────────────────────

    @staticmethod
    async def _fetch_payments(
        access_token: str,
        location_id: Optional[str] = None,
        begin_time: Optional[datetime] = None,
    ) -> list[dict]:
        """Fetch Square payment records for the past _PAYMENTS_DAYS days.

        Returns a flat list of Square payment objects.
        Cursor pagination is followed until exhausted.
        """
        if begin_time is None:
            begin_time = datetime.now(timezone.utc) - timedelta(days=_PAYMENTS_DAYS)

        begin_str = begin_time.strftime("%Y-%m-%dT%H:%M:%SZ")
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Square-Version": _SQUARE_VERSION,
            "Content-Type": "application/json",
        }
        params: dict = {"begin_time": begin_str, "sort_order": "ASC"}
        if location_id:
            params["location_id"] = location_id

        payments: list[dict] = []
        async with httpx.AsyncClient(base_url=_SQUARE_BASE, timeout=30) as client:
            while True:
                resp = await client.get("/v2/payments", headers=headers, params=params)
                if resp.status_code >= 400:
                    logger.error(
                        "Square Payments API error %s: %s",
                        resp.status_code,
                        resp.text[:500],
                    )
                    break
                data = resp.json()
                payments.extend(data.get("payments") or [])
                cursor = data.get("cursor")
                if not cursor:
                    break
                params["cursor"] = cursor

        return payments

    def _upsert_payment(
        self,
        db: Session,
        user_id: uuid.UUID,
        payment: dict,
        run: object,
    ) -> tuple[Optional[Transaction], bool]:
        """Upsert a canonical Transaction from a Square payment object.

        Identity key: payment['id'] stored as Transaction.external_reference_id
        with source='square'.  Returns (transaction, created).
        """
        payment_id = payment.get("id", "")
        if not payment_id:
            return None, False

        # Amount: Square returns total_money.amount in cents
        total_money = payment.get("total_money") or {}
        amount_cents = total_money.get("amount", 0) or 0
        amount = Decimal(str(amount_cents)) / Decimal("100")

        # Map Square status to Vendora status
        sq_status = (payment.get("status") or "").upper()
        status_map = {
            "COMPLETED": "completed",
            "APPROVED": "completed",
            "PENDING": "pending",
            "CANCELED": "refunded",
            "FAILED": "refunded",
        }
        txn_status = status_map.get(sq_status, "completed")

        created_at_str = payment.get("created_at", "")
        try:
            created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            created_at = datetime.now(timezone.utc)

        existing = (
            db.query(Transaction)
            .filter_by(
                user_id=user_id,
                source="square",
                external_reference_id=payment_id,
            )
            .one_or_none()
        )

        if existing:
            # Idempotent update — only touch mutable fields
            existing.gross_amount = amount
            existing.net_amount = amount
            existing.status = txn_status
            db.add(existing)
            return existing, False

        txn = Transaction(
            user_id=user_id,
            source="square",
            external_reference_id=payment_id,
            gross_amount=amount,
            fee_amount=Decimal("0.00"),
            net_amount=amount,
            method="other",
            status=txn_status,
            notes=f"Imported from Square payment {payment_id}",
        )
        db.add(txn)
        return txn, True

    # ── ProviderAdapter._do_sync ──────────────────────────────────────────────

    async def _do_sync(
        self, db: Session, user_id: uuid.UUID, run: object
    ) -> SyncResult:
        """Pull Square catalog + inventory into Vendora.

        Step 1: Fetch all ITEM catalog objects (paginated).
        Step 2: Collect all ITEM_VARIATION objects with their parent name.
        Step 3: Batch-fetch IN_STOCK inventory counts.
        Step 4: Upsert each variation into the canonical inventory tables.
        """
        from app.models.provider import ProviderSyncRun  # local import avoids circular

        cred = self._get_credential(db, user_id)
        if cred is None:
            raise RuntimeError(
                f"Square credentials not found for user {user_id}. "
                "Call POST /integrations/square/connect first."
            )

        result = SyncResult(run_id=run.id)  # type: ignore[attr-defined]

        # ── Step 1: Catalog ───────────────────────────────────────────────────
        catalog_items = await self._fetch_catalog(decrypt_token(cred.access_token))

        # ── Step 2: Collect variations ────────────────────────────────────────
        # all_variations: list of (variation_dict, parent_item_name)
        all_variations: list[tuple[dict, str]] = []
        for catalog_obj in catalog_items:
            if catalog_obj.get("type") != "ITEM":
                continue
            item_data = catalog_obj.get("item_data") or {}
            parent_name: str = (item_data.get("name") or "Unnamed Item").strip()
            for variation in item_data.get("variations") or []:
                all_variations.append((variation, parent_name))

        # ── Step 3: Inventory counts ──────────────────────────────────────────
        variation_ids = [v.get("id", "") for v, _ in all_variations if v.get("id")]
        qty_map = await self._fetch_inventory_counts(
            decrypt_token(cred.access_token), variation_ids, cred.location_id
        )

        # ── Step 4: Upsert ────────────────────────────────────────────────────
        for variation, parent_name in all_variations:
            vid = variation.get("id", "")
            qty = qty_map.get(vid, 0)

            try:
                item, created = self._upsert_item(
                    db, user_id, variation, qty, parent_name, run
                )
                if item is None:
                    result.items_skipped += 1
                    result.errors_count += 1
                elif created:
                    result.items_imported += 1
                else:
                    result.items_updated += 1
            except Exception as exc:
                logger.error(
                    "Square: unhandled error upserting variation %s: %s", vid, exc
                )
                self.record_issue(
                    db,
                    user_id,
                    "import_error",
                    "error",
                    run=run,
                    external_id=vid or None,
                    details={"error": str(exc)[:500]},
                )
                result.errors_count += 1

        # ── Step 5: Payments ──────────────────────────────────────────────────
        try:
            payments = await self._fetch_payments(
                decrypt_token(cred.access_token), location_id=cred.location_id
            )
            for payment in payments:
                try:
                    txn, created = self._upsert_payment(db, user_id, payment, run)
                    if txn is not None:
                        if created:
                            result.transactions_imported += 1
                        else:
                            result.transactions_updated += 1
                except Exception as exc:
                    logger.error("Square: error upserting payment %s: %s", payment.get("id"), exc)
                    result.errors_count += 1
        except Exception as exc:
            logger.error("Square: payment fetch failed: %s", exc)
            # Non-fatal — inventory import already succeeded

        return result


# Module-level singleton — matches the lightspeed_service pattern
square_service = SquareService()
