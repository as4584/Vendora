"""Inventory router — /api/v1/inventory endpoints.

Soft-delete 404 rule: All GET/PUT/PATCH filter WHERE deleted_at IS NULL.
Soft-deleted records return 404, never exposed.
"""
import logging
import re
import csv
import asyncio
import io
import ipaddress
import math
import socket
import os
import shutil
import uuid
import threading
import base64
import binascii
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from decimal import Decimal
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal, Optional
from uuid import UUID
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel as _PydBase
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.services import analytics
from app.database import SessionLocal, get_db
from app.models.user import User
from app.models.inventory import (
    InventoryItem,
    InventoryImportJob,
    InventoryImportRow,
    InventoryStockLedger,
)
from app.schemas.inventory import (
    ItemCreate,
    ItemUpdate,
    ItemResponse,
    StatusUpdate,
    PaginatedItems,
    PhotoUpdate,
    ImportJobResponse,
    ImportPreviewResponse,
    ImportRowResult,
    ImportRowUpdate,
    ImportCommitResponse,
    InventoryActivityEntry,
    InventoryImportRequest,
    InventoryImportResult,
)
from app.dependencies.auth import get_current_user
from app.dependencies.tier_limiter import TIER_LIMITS, enforce_item_limit
from app.services import smart_search
from app.services.inventory import transition_item
from app.services.scan_memory import remember_items
from app.services.spreadsheet_import import (
    detect_format,
    google_sheet_candidate_csv_urls,
    google_sheet_export_urls,
    google_sheet_csv_url,
    parse_inventory_rows,
    extract_url,
    normalize_header,
    parse_money,
    parse_quantity,
    resolve_field,
    rows_from_bytes,
    unescape_cell,
    xlsx_rows_from_path,
    MAX_CSV_IMPORT_BYTES,
    MAX_XLSX_IMPORT_BYTES,
)

logger = logging.getLogger(__name__)

# Upper bound on rows scored per search (a seller's whole active inventory).
SEARCH_CANDIDATE_LIMIT = 5000

router = APIRouter(prefix="/inventory", tags=["inventory"])

# ---------------------------------------------------------------------------
# Canonical CSV header → InventoryItem field mapping (case-insensitive)
# ---------------------------------------------------------------------------
IMPORT_HEADER_MAP: dict[str, str] = {
    "name": "name", "item name": "name", "product name": "name", "title": "name",
    "sku": "sku", "part number": "sku",
    "upc": "upc", "barcode": "upc",
    "category": "category",
    "condition": "condition",
    "size": "size",
    "color": "color",
    # Natural-language aliases (for human-authored spreadsheets)
    "buy price": "buy_price", "cost": "buy_price", "unit cost": "buy_price",
    "sell price": "expected_sell_price", "price": "expected_sell_price",
    "expected sell price": "expected_sell_price",
    "vendor": "vendor_name", "vendor name": "vendor_name",
    # Snake-case aliases — exact column names written by the CSV exporter.
    # These make export → edit → re-import round-trips work without column remapping.
    "buy_price": "buy_price",
    "expected_sell_price": "expected_sell_price",
    "actual_sell_price": "actual_sell_price",
    "vendor_name": "vendor_name",
    "quantity": "quantity", "qty": "quantity", "stock": "quantity",
    "notes": "notes", "description": "notes",
    "platform": "platform",
    "photo_front_url": "photo_front_url",
    "photo_back_url": "photo_back_url",
    "front photo": "photo_front_url",
    "back photo": "photo_back_url",
    "front photo url": "photo_front_url",
    "back photo url": "photo_back_url",
    # Round-trip support: exported 'id' column used as a match key on re-import.
    # id is never written to the item directly; it is used only for lookup.
    "id": "_import_id",
}


def _get_active_item(item_id: str, user_id, db: Session) -> InventoryItem:
    """Helper: fetch an active (non-deleted), user-owned inventory item or raise 404."""
    item = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.id == item_id,
            InventoryItem.user_id == user_id,
            InventoryItem.deleted_at.is_(None),
        )
        .first()
    )
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Item not found.",
        )
    return item


def _public_url_parts(url: str):
    parsed = urlparse(url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Import link must be a public http(s) spreadsheet URL.",
        )

    host = parsed.hostname.lower().rstrip(".")
    try:
        ip = ipaddress.ip_address(host)
        if not ip.is_global:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Import link must be publicly reachable.",
            )
    except ValueError:
        blocked_hosts = {"localhost", "localhost.localdomain", "0.0.0.0"}
        if host in blocked_hosts or host.endswith((".local", ".internal", ".localhost")):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Import link must be publicly reachable.",
            )
    if parsed.port not in {None, 80, 443}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Import links may only use standard HTTP or HTTPS ports.",
        )
    return parsed


def _validate_import_host(url: str) -> list[str]:
    parsed = _public_url_parts(url)
    if parsed.hostname.lower().rstrip(".") in {"docs.google.com", "www.docs.google.com"}:
        return google_sheet_export_urls(url)
    return [google_sheet_csv_url(url)]


async def _assert_public_dns(url: str) -> None:
    parsed = _public_url_parts(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addresses = await asyncio.to_thread(
            socket.getaddrinfo,
            parsed.hostname,
            port,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail="Import link host could not be resolved.") from exc
    resolved = {entry[4][0] for entry in addresses}
    if not resolved or any(not ipaddress.ip_address(address).is_global for address in resolved):
        raise HTTPException(status_code=400, detail="Import link must resolve only to public addresses.")


def _assert_public_peer(response: httpx.Response) -> None:
    stream = getattr(response, "extensions", {}).get("network_stream")
    if stream is None:
        return
    peer = stream.get_extra_info("server_addr")
    if peer and not ipaddress.ip_address(peer[0]).is_global:
        raise HTTPException(status_code=400, detail="Import link connected to a non-public address.")


async def _download_public_content(
    client: httpx.AsyncClient,
    url: str,
    *,
    max_bytes: int = MAX_XLSX_IMPORT_BYTES,
) -> tuple[bytes, str | None, str]:
    @asynccontextmanager
    async def response_context(request_url: str):
        # The compatibility branch keeps lightweight test doubles useful; the
        # production httpx client always takes the streaming branch.
        if hasattr(client, "stream"):
            async with client.stream("GET", request_url) as streamed_response:
                yield streamed_response
        else:
            yield await client.get(request_url)

    current_url = url
    for _ in range(6):
        await _assert_public_dns(current_url)
        async with response_context(current_url) as response:
            _assert_public_peer(response)
            if getattr(response, "is_redirect", False):
                location = response.headers.get("location")
                if not location:
                    raise HTTPException(status_code=400, detail="Spreadsheet link returned an invalid redirect.")
                current_url = urljoin(current_url, location)
                continue
            response.raise_for_status()
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > max_bytes:
                raise HTTPException(status_code=413, detail="Spreadsheet download is too large.")
            content = bytearray()
            if hasattr(response, "aiter_bytes"):
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > max_bytes:
                        raise HTTPException(status_code=413, detail="Spreadsheet download is too large.")
            else:
                content.extend(response.content)
                if len(content) > max_bytes:
                    raise HTTPException(status_code=413, detail="Spreadsheet download is too large.")
            return bytes(content), response.headers.get("content-type"), current_url
    raise HTTPException(status_code=400, detail="Spreadsheet link redirected too many times.")


async def _read_upload_limited(file: UploadFile, max_bytes: int) -> bytes:
    content = bytearray()
    while chunk := await file.read(1024 * 1024):
        content.extend(chunk)
        if len(content) > max_bytes:
            raise HTTPException(status_code=413, detail="Spreadsheet upload is too large.")
    return bytes(content)


def _find_import_match(
    db: Session,
    user_id,
    payload: dict,
    external_id: str,
    item_id: str | None = None,
) -> InventoryItem | None:
    # A Resqlo export carries each item's id: that is the strongest match,
    # and lets renamed items or manual items without SKU/UPC update in place.
    if item_id:
        try:
            parsed_id = uuid.UUID(item_id)
        except ValueError:
            parsed_id = None
        if parsed_id is not None:
            match = db.query(InventoryItem).filter(
                InventoryItem.user_id == user_id,
                InventoryItem.deleted_at.is_(None),
                InventoryItem.id == parsed_id,
            ).first()
            if match:
                return match
    if payload.get("upc"):
        match = db.query(InventoryItem).filter(
            InventoryItem.user_id == user_id,
            InventoryItem.deleted_at.is_(None),
            InventoryItem.upc == payload["upc"],
        ).first()
        if match:
            return match
    if payload.get("sku"):
        same_sku = db.query(InventoryItem).filter(
            InventoryItem.user_id == user_id,
            InventoryItem.deleted_at.is_(None),
            InventoryItem.sku == payload["sku"],
        ).all()
        match = _match_existing(same_sku, payload.get("size"))
        if match:
            return match
    return db.query(InventoryItem).filter(
        InventoryItem.user_id == user_id,
        InventoryItem.deleted_at.is_(None),
        InventoryItem.source == "spreadsheet",
        InventoryItem.external_id == external_id,
    ).first()


def _import_inventory_content(
    *,
    filename: str,
    content_type: str | None,
    content: bytes,
    dry_run: bool,
    source_name: str | None,
    db: Session,
    current_user: User,
) -> InventoryImportResult:
    rows = rows_from_bytes(content, detect_format(filename, content_type, content), content_type)
    parsed_rows = parse_inventory_rows(rows)
    touched: list[InventoryItem] = []

    result = {
        "dry_run": dry_run,
        "rows_seen": len(rows),
        "rows_importable": 0,
        "created": 0,
        "updated": 0,
        "skipped": 0,
        "errors": [],
        "warnings": [],
        "sample_items": [],
    }

    existing_count = db.query(InventoryItem).filter(
        InventoryItem.user_id == current_user.id,
        InventoryItem.deleted_at.is_(None),
    ).count()
    tier_limit = TIER_LIMITS.get(current_user.subscription_tier)

    for parsed_row in parsed_rows:
        for warning in parsed_row.warnings:
            result["warnings"].append({"row": parsed_row.row_number, "message": warning})

        if not parsed_row.payload:
            result["skipped"] += 1
            continue

        result["rows_importable"] += 1
        match = _find_import_match(
            db, current_user.id, parsed_row.payload, parsed_row.external_id, parsed_row.item_id
        )
        if match:
            result["updated"] += 1
        else:
            if tier_limit is not None and existing_count + result["created"] >= tier_limit:
                result["skipped"] += 1
                result["errors"].append({
                    "row": parsed_row.row_number,
                    "message": f"Tier limit reached at {tier_limit} inventory items.",
                })
                continue
            result["created"] += 1

        if len(result["sample_items"]) < 5:
            result["sample_items"].append(parsed_row.payload)

        if dry_run:
            continue

        payload = dict(parsed_row.payload)
        raw_attrs = payload.pop("custom_attributes", {}) or {}
        if match:
            existing_attrs = match.custom_attributes or {}
            payload["custom_attributes"] = {**existing_attrs, **raw_attrs}
            for field, value in payload.items():
                setattr(match, field, value)
            db.add(match)
            touched.append(match)
        else:
            item = InventoryItem(
                user_id=current_user.id,
                source="spreadsheet",
                external_id=parsed_row.external_id,
                custom_attributes=raw_attrs,
                **payload,
            )
            db.add(item)
            # Make the new row visible to _find_import_match so a SKU/UPC that
            # repeats later in the same file updates it instead of colliding.
            db.flush()
            touched.append(item)

    if not dry_run:
        _remember_imported(db, current_user.id, touched)
        db.commit()

    return InventoryImportResult(**result)


@router.post("", response_model=ItemResponse, status_code=status.HTTP_201_CREATED)
def create_item(
    payload: ItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(enforce_item_limit),
):
    """Create a new inventory item. Tier limit enforced (Free: 25 max)."""
    item = InventoryItem(
        user_id=current_user.id,
        name=payload.name,
        category=payload.category,
        sku=payload.sku,
        upc=payload.upc,
        size=payload.size,
        color=payload.color,
        condition=payload.condition,
        serial_number=payload.serial_number,
        custom_attributes=payload.custom_attributes or {},
        buy_price=payload.buy_price,
        expected_sell_price=payload.expected_sell_price,
        actual_sell_price=payload.actual_sell_price,
        platform=payload.platform,
        photo_front_url=payload.photo_front_url,
        photo_back_url=payload.photo_back_url,
        quantity=payload.quantity,
        vendor_name=payload.vendor_name,
        notes=payload.notes,
    )
    db.add(item)
    db.flush()
    _sheet_push(db, item)
    db.commit()
    analytics.track_first(db, current_user.id, "item_created")
    db.commit()
    db.refresh(item)
    return item


def _sheet_push(db: Session, item: InventoryItem) -> None:
    """Keep a linked Google Sheet row in step with an app-side edit."""
    from app.services.google_sheets import enqueue_sheet_push

    enqueue_sheet_push(db, item)


def _sort_order(sort: str) -> list:
    """ORDER BY for the list's sort menu; id breaks ties so pages never overlap."""
    price = InventoryItem.expected_sell_price
    orders = {
        "newest": [InventoryItem.created_at.desc()],
        "oldest": [InventoryItem.created_at.asc()],
        "price_high": [price.desc().nulls_last()],
        "price_low": [price.asc().nulls_last()],
        "profit": [(price - InventoryItem.buy_price).desc().nulls_last()],
        "qty": [InventoryItem.quantity.desc()],
        "name": [func.lower(InventoryItem.name).asc()],
    }
    return [*orders[sort], InventoryItem.id.asc()]


@router.get("", response_model=PaginatedItems)
def list_items(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    q: Optional[str] = Query(
        None,
        max_length=200,
        description="Smart search: name, SKU, UPC, size ('sz 10'), color, card details, nicknames; typo tolerant",
    ),
    status_filter: Optional[str] = Query(None, alias="status", description="Filter by status"),
    source_filter: Optional[str] = Query(None, alias="source", description="Filter by source (e.g. lightspeed)"),
    available_only: bool = Query(False, description="Only items with quantity > 0 and status in (in_stock, listed)"),
    upc: Optional[str] = Query(None, max_length=50, description="Exact barcode (UPC/EAN) match, for scan-to-sell"),
    missing_cost: bool = Query(False, description="Only items with no buy price (profit can't be computed)"),
    sort: str = Query(
        "newest",
        pattern="^(newest|oldest|price_high|price_low|profit|qty|name)$",
        description="Order: newest, oldest (longest in stock), price_high, price_low, profit, qty, name",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List inventory items with pagination and optional search/filters."""
    base_query = db.query(InventoryItem).filter(
        InventoryItem.user_id == current_user.id,
        InventoryItem.deleted_at.is_(None),
    )

    if upc:
        code = upc.strip()
        # Scanners report UPC-A (12) as EAN-13 with a leading 0 and vice versa.
        variants = {code, f"0{code}"}
        if code.startswith("0") and len(code) > 1:
            variants.add(code[1:])
        base_query = base_query.filter(InventoryItem.upc.in_(sorted(variants)))

    if status_filter:
        base_query = base_query.filter(InventoryItem.status == status_filter)

    if source_filter:
        base_query = base_query.filter(InventoryItem.source == source_filter)

    if missing_cost:
        base_query = base_query.filter(InventoryItem.buy_price.is_(None))

    if available_only:
        base_query = base_query.filter(
            InventoryItem.status.in_(["in_stock", "listed"]),
            InventoryItem.quantity > 0,
        )

    if q and q.strip():
        # Rank in Python: typo tolerance, sizes and nicknames don't map to ILIKE.
        candidates = (
            base_query.order_by(InventoryItem.created_at.desc())
            .limit(SEARCH_CANDIDATE_LIMIT)
            .all()
        )
        ranked = smart_search.rank(candidates, q)
        total = len(ranked)
        items = ranked[(page - 1) * per_page : page * per_page]
        return PaginatedItems(
            items=items,
            total=total,
            page=page,
            per_page=per_page,
            pages=math.ceil(total / per_page) if total > 0 else 0,
        )

    total = base_query.count()
    items = (
        base_query
        .order_by(*_sort_order(sort))
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return PaginatedItems(
        items=items,
        total=total,
        page=page,
        per_page=per_page,
        pages=math.ceil(total / per_page) if total > 0 else 0,
    )


@router.post("/import", response_model=InventoryImportResult)
async def import_inventory_from_link(
    payload: InventoryImportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Import inventory from a public/read-only spreadsheet link.

    Supports Google Sheets read-only URLs by converting them to XLSX/CSV export URLs.
    """
    import_urls = _validate_import_host(payload.url)
    if payload.dry_run:
        import_urls = sorted(import_urls, key=lambda candidate: 0 if "format=csv" in candidate else 1)
    last_error: HTTPException | None = None
    timeout = httpx.Timeout(120.0, connect=20.0)
    headers = {
        "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,*/*",
        "User-Agent": "VendoraSpreadsheetImport/1.0",
    }

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, headers=headers) as client:
        for import_url in import_urls:
            try:
                content, content_type, final_url = await _download_public_content(client, import_url)
            except httpx.HTTPStatusError as exc:
                last_error = HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Spreadsheet link returned HTTP {exc.response.status_code}.",
                )
                continue
            except httpx.HTTPError:
                last_error = HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Could not download the spreadsheet link.",
                )
                continue

            try:
                return _import_inventory_content(
                    filename=urlparse(final_url).path,
                    content_type=content_type,
                    content=content,
                    dry_run=payload.dry_run,
                    source_name=payload.source_name,
                    db=db,
                    current_user=current_user,
                )
            except HTTPException as exc:
                last_error = exc
                if "web page instead of spreadsheet data" in str(exc.detail):
                    continue
                if "Could not find an inventory header row" in str(exc.detail):
                    discovery_text = content.decode("utf-8", errors="replace")
                    try:
                        discovery_content, _, _ = await _download_public_content(
                            client, payload.url, max_bytes=MAX_CSV_IMPORT_BYTES
                        )
                        discovery_text = discovery_content.decode("utf-8", errors="replace")
                    except (httpx.HTTPError, HTTPException):
                        pass
                    extra_urls = google_sheet_candidate_csv_urls(payload.url, discovery_text)
                    for extra_url in extra_urls:
                        if extra_url not in import_urls:
                            import_urls.append(extra_url)
                    if extra_urls:
                        continue
                raise

    if last_error:
        raise last_error
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Could not download the spreadsheet link.",
    )


@router.post("/import/file", response_model=InventoryImportResult)
async def import_inventory_file(
    file: UploadFile = File(...),
    dry_run: bool = Query(False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Import inventory from an uploaded CSV or XLSX spreadsheet."""
    filename = file.filename or "inventory.csv"
    max_bytes = MAX_XLSX_IMPORT_BYTES if filename.lower().endswith(".xlsx") else MAX_CSV_IMPORT_BYTES
    content = await _read_upload_limited(file, max_bytes)
    return _import_inventory_content(
        filename=filename,
        content_type=file.content_type,
        content=content,
        dry_run=dry_run,
        source_name="file-upload",
        db=db,
        current_user=current_user,
    )


@router.get("/market-price")
async def get_market_price(
    query: str = Query(..., description="Item name to look up"),
    upc: str | None = Query(None, description="UPC barcode if known"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Market price lookup. Queries UPC database + internal Resqlo history."""
    result: dict = {
        "query": query,
        "upc": upc,
        "product_info": None,
        "sources": [],
        "internal_history": {"avg_sold_price": None, "sample_count": 0},
    }

    # 1. UPC item lookup via free upcitemdb trial (no API key required)
    if upc:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(
                    "https://api.upcitemdb.com/prod/trial/lookup",
                    params={"upc": upc},
                    headers={"User-Agent": "Vendora/1.0"},
                )
            if r.status_code == 200:
                items = r.json().get("items", [])
                if items:
                    i = items[0]
                    result["product_info"] = {
                        "title": i.get("title"),
                        "name": i.get("title"),
                        "brand": i.get("brand"),
                        "description": i.get("description"),
                        "image_url": (i.get("images") or [None])[0],
                        "category": i.get("category"),
                        "images": (i.get("images") or [])[:2],
                        "lowest_price": None,
                        "highest_price": None,
                    }
                    prices = [
                        float(o["price"])
                        for o in i.get("offers", [])
                        if o.get("price") and float(o.get("price", 0)) > 0
                    ]
                    if prices:
                        result["product_info"]["lowest_price"] = round(min(prices), 2)
                        result["product_info"]["highest_price"] = round(max(prices), 2)
                        result["sources"].append({
                            "source": "retail",
                            "label": "Retail prices",
                            "price": round(sum(prices) / len(prices), 2),
                            "low": round(min(prices), 2),
                            "high": round(max(prices), 2),
                            "avg": round(sum(prices) / len(prices), 2),
                            "count": len(prices),
                        })
        except Exception:
            logger.warning("Market price: retail lookup failed", exc_info=True)

    # 2. Internal history — avg sell price for similar-named items in user's account
    name_avg = (
        db.query(func.avg(InventoryItem.actual_sell_price))
        .filter(
            InventoryItem.user_id == current_user.id,
            InventoryItem.actual_sell_price.isnot(None),
            InventoryItem.name.ilike(f"%{query[:20]}%"),
        )
        .scalar()
    )
    if name_avg:
        sample_count = (
            db.query(func.count(InventoryItem.id))
            .filter(
                InventoryItem.user_id == current_user.id,
                InventoryItem.actual_sell_price.isnot(None),
                InventoryItem.name.ilike(f"%{query[:20]}%"),
            )
            .scalar()
            or 0
        )
        result["internal_history"] = {
            "avg_sold_price": round(float(name_avg), 2),
            "sample_count": sample_count,
        }
        result["sources"].append({
            "source": "vendora_history",
            "label": "Your avg sell price",
            "price": round(float(name_avg), 2),
            "avg": round(float(name_avg), 2),
        })

    # 3. eBay comps — active asks unless the keyset has sold data. Labelled by kind
    # so the app never shows asking prices as sold prices.
    from app.config import settings as _settings

    if _settings.EBAY_CLIENT_ID and _settings.EBAY_CLIENT_SECRET:
        try:
            from app.services.ebay_listing import fetch_comps

            comps = await fetch_comps(query)
            if comps.get("summary"):
                summ = comps["summary"]
                result["sources"].append({
                    "source": "ebay_sold" if comps["kind"] == "sold" else "ebay_active_asks",
                    "label": comps["label"],
                    "price": float(summ["median"]),
                    "low": float(summ["low"]),
                    "high": float(summ["high"]),
                    "count": comps["count"],
                })
        except Exception:
            logger.warning("Market price: eBay comps lookup failed", exc_info=True)

    return result


@router.get("/{item_id}/ebay-comps")
async def get_ebay_comps(
    item_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """eBay comps for an item. ``kind`` is "active_asks" (asking prices) unless
    the keyset has Marketplace Insights, in which case it is "sold"."""
    from app.services.ebay_listing import fetch_comps
    from app.services.feature_flags import require_market_pricing

    item = _get_active_item(item_id, current_user.id, db)
    require_market_pricing(current_user)
    brand = (item.custom_attributes or {}).get("brand") if isinstance(item.custom_attributes, dict) else None
    parts = [str(brand)] if brand and str(brand).lower() not in item.name.lower() else []
    parts.append(item.name)
    if item.size:
        parts.append(f"size {item.size}")
    cond = (item.condition or "").lower()
    condition = "used" if ("used" in cond or "pre" in cond) else ("new" if cond else None)
    result = await fetch_comps(" ".join(parts), condition=condition)
    result["item_id"] = str(item.id)
    return result


@router.get("/{item_id}/pricing-suggestion")
def get_pricing_suggestion(
    item_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Smart pricing suggestion using own sales history and buy price margin."""
    from app.services.feature_flags import require_market_pricing

    item = _get_active_item(item_id, current_user.id, db)
    require_market_pricing(current_user)

    category_avg = (
        db.query(func.avg(InventoryItem.actual_sell_price))
        .filter(
            InventoryItem.user_id == current_user.id,
            InventoryItem.actual_sell_price.isnot(None),
            InventoryItem.category == item.category,
            InventoryItem.id != item.id,
        )
        .scalar()
    ) if item.category else None

    name_avg = (
        db.query(func.avg(InventoryItem.actual_sell_price))
        .filter(
            InventoryItem.user_id == current_user.id,
            InventoryItem.actual_sell_price.isnot(None),
            InventoryItem.name.ilike(f"%{item.name[:15]}%"),
            InventoryItem.id != item.id,
        )
        .scalar()
    )

    margin_30 = round(float(item.buy_price) * 1.30, 2) if item.buy_price else None

    if name_avg:
        suggested = round(float(name_avg), 2)
        reason = "Based on your historical sales for similar items"
        confidence = "high"
        basis = "similar_items"
    elif category_avg:
        suggested = round(float(category_avg), 2)
        reason = f"Based on your {item.category} category average"
        confidence = "medium"
        basis = "category_average"
    elif margin_30:
        suggested = margin_30
        reason = "30% margin over your buy price"
        confidence = "low"
        basis = "cost_margin"
    else:
        suggested = None
        reason = "Add more sales data to unlock smart suggestions"
        confidence = "low"
        basis = "insufficient_data"

    return {
        "item_id": str(item.id),
        "current_expected": float(item.expected_sell_price) if item.expected_sell_price else None,
        "suggested_price": suggested,
        "reason": reason,
        "confidence": confidence,
        "basis": basis,
        "category_avg": round(float(category_avg), 2) if category_avg else None,
        "name_avg": round(float(name_avg), 2) if name_avg else None,
        "margin_30_percent": margin_30,
    }


class AgingItem(_PydBase):
    id: UUID
    name: str
    expected_sell_price: Optional[Decimal] = None
    buy_price: Optional[Decimal] = None
    days_old: int


class AgingResponse(_PydBase):
    days: int
    count: int
    items: list[AgingItem]


@router.get("/aging", response_model=AgingResponse)
def get_aging_items(
    days: int = Query(60, ge=7, le=730),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """In-stock/listed items older than `days`, oldest first (up to 100)."""
    from app.services.aging import aging_items

    now = datetime.now(timezone.utc)
    count, items = aging_items(db, current_user.id, days=days, now=now)
    return AgingResponse(
        days=days,
        count=count,
        items=[
            AgingItem(
                id=i.id, name=i.name, expected_sell_price=i.expected_sell_price, buy_price=i.buy_price,
                days_old=(now - (i.created_at if i.created_at.tzinfo else i.created_at.replace(tzinfo=timezone.utc))).days,
            )
            for i in items
        ],
    )
@router.get("/labels.pdf")
def get_price_labels(
    ids: str = Query(..., description="Comma-separated item ids (max 200)"),
    layout: Literal["thermal", "sheet"] = Query("thermal"),
    per_unit: bool = Query(False, description="One label per unit in stock"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Printable price labels with a scan-to-sell QR code."""
    from app.services.labels import build_labels_pdf, expand

    try:
        wanted = list(dict.fromkeys(UUID(part.strip()) for part in ids.split(",") if part.strip()))
    except ValueError:
        raise HTTPException(status_code=422, detail="ids must be item UUIDs")
    if not wanted or len(wanted) > 200:
        raise HTTPException(status_code=422, detail="Pick between 1 and 200 items")
    found = {
        item.id: item for item in db.query(InventoryItem).filter(
            InventoryItem.id.in_(wanted), InventoryItem.user_id == current_user.id, InventoryItem.deleted_at.is_(None),
        ).all()
    }
    if not found:
        raise HTTPException(status_code=404, detail="Items not found")
    pdf = build_labels_pdf(expand([found[i] for i in wanted if i in found], per_unit), layout)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": 'inline; filename="resqlo-labels.pdf"'})


@router.get("/{item_id}", response_model=ItemResponse)
def get_item(
    item_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single inventory item. Returns 404 if deleted or not owned."""
    return _get_active_item(item_id, current_user.id, db)


class LastSaleResponse(_PydBase):
    unit_price: Decimal
    sold_at: datetime
    quantity: int
    # Where the price came from: this item, another item with the same SKU,
    # or another item with the same name (case-insensitive).
    match: Literal["this_item", "same_sku", "same_name"]


@router.get("/{item_id}/last-sale", response_model=Optional[LastSaleResponse])
def last_sale(
    item_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """What this (or the same) product last sold for, to price with confidence at checkout."""
    from app.models.transaction import Transaction

    item = _get_active_item(item_id, current_user.id, db)
    sales = (
        db.query(Transaction)
        .join(InventoryItem, InventoryItem.id == Transaction.item_id)
        .filter(
            Transaction.user_id == current_user.id,
            Transaction.is_refund.is_(False),
            Transaction.status == "completed",
        )
        .order_by(Transaction.created_at.desc())
    )
    tiers: list[tuple[str, object]] = [("this_item", Transaction.item_id == item.id)]
    if item.sku and item.sku.strip():
        tiers.append(("same_sku", func.lower(InventoryItem.sku) == item.sku.strip().lower()))
    tiers.append(("same_name", func.lower(InventoryItem.name) == item.name.strip().lower()))
    for match, condition in tiers:
        txn = sales.filter(condition).first()
        if txn:
            qty = max(1, txn.quantity or 1)
            return LastSaleResponse(
                unit_price=(Decimal(txn.gross_amount) / qty).quantize(Decimal("0.01")),
                sold_at=txn.created_at,
                quantity=qty,
                match=match,
            )
    return None


@router.get("/{item_id}/activity", response_model=list[InventoryActivityEntry])
def get_item_activity(
    item_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return immutable stock/activity history for an item, newest first."""
    item = _get_active_item(item_id, current_user.id, db)
    return (
        db.query(InventoryStockLedger)
        .filter(InventoryStockLedger.inventory_item_id == item.id)
        .order_by(InventoryStockLedger.created_at.desc())
        .limit(limit)
        .all()
    )


@router.put("/{item_id}", response_model=ItemResponse)
def update_item(
    item_id: UUID,
    payload: ItemUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update an inventory item. Cannot update status here — use PATCH /status."""
    item = _get_active_item(item_id, current_user.id, db)

    update_data = payload.model_dump(exclude_unset=True)
    new_qty = update_data.pop("quantity", None)
    expected_qty = update_data.pop("expected_quantity", None)
    for field, value in update_data.items():
        setattr(item, field, value)

    if new_qty is not None:
        _apply_quantity_edit(db, item, new_qty, expected_qty)

    db.add(item)
    _sheet_push(db, item)
    db.commit()
    db.refresh(item)
    return item


def _apply_quantity_edit(db: Session, item: InventoryItem, new_qty: int, expected_qty: int | None) -> None:
    """Apply a manual stock edit through the ledger, keeping status in step.

    With expected_qty, the edit is a delta on the current (locked) stock, so a
    sale recorded since the client loaded the item isn't undone.
    """
    from app.models.inventory import InventoryStockLedger

    db.flush()
    db.refresh(item, with_for_update=True)
    current = item.quantity or 0
    target = new_qty if expected_qty is None else max(0, current + (new_qty - expected_qty))
    if target == current:
        return
    item.quantity = target
    if target == 0 and item.status in ("in_stock", "listed"):
        item.status = "sold"
    elif target > 0 and item.status == "sold":
        item.status = "in_stock"
        item.actual_sell_price = None
    db.add(InventoryStockLedger(
        inventory_item_id=item.id,
        user_id=item.user_id,
        delta_quantity=target - current,
        quantity_after=target,
        event_type="manual_adjust",
        source_type="manual",
        source_id=str(item.id),
    ))
    from app.services.inventory import enqueue_stock_change

    enqueue_stock_change(db, item, source_type="manual")


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(
    item_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete an inventory item. Sets deleted_at = now().
    Item can be recovered within 30 days.
    """
    item = _get_active_item(item_id, current_user.id, db)
    item.deleted_at = datetime.now(timezone.utc)
    db.add(item)
    db.commit()
    return None


class BulkDeleteRequest(_PydBase):
    item_ids: list[str]
    # When true, also try to remove the item from its original source (e.g. a
    # connected spreadsheet/POS). Read-only imports can't be written back to.
    delete_from_source: bool = False


class BulkDeleteResponse(_PydBase):
    deleted: int
    source_removed: int = 0
    source_unsupported: int = 0
    source_note: str = ""


@router.post("/bulk-delete", response_model=BulkDeleteResponse)
def bulk_delete_items(
    payload: BulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete many inventory items at once (owned + active only).

    `delete_from_source` note: spreadsheet imports are read-only (a public
    Sheets URL or an uploaded file), so items sourced from a spreadsheet cannot
    be removed at the source from here — those are counted in `source_unsupported`.
    """
    if not payload.item_ids:
        raise HTTPException(status_code=400, detail="item_ids is required")

    deleted = 0
    source_unsupported = 0
    now = datetime.now(timezone.utc)
    for item_id in payload.item_ids[:500]:
        item = (
            db.query(InventoryItem)
            .filter(
                InventoryItem.id == item_id,
                InventoryItem.user_id == current_user.id,
                InventoryItem.deleted_at.is_(None),
            )
            .first()
        )
        if not item:
            continue
        if payload.delete_from_source and item.source == "spreadsheet":
            source_unsupported += 1
        item.deleted_at = now
        db.add(item)
        deleted += 1
    db.commit()

    note = ""
    if payload.delete_from_source and source_unsupported:
        note = (
            f"{source_unsupported} item(s) came from a read-only spreadsheet import, "
            "so they were removed from Resqlo but can't be edited in your original sheet."
        )
    return BulkDeleteResponse(
        deleted=deleted,
        source_removed=0,
        source_unsupported=source_unsupported,
        source_note=note,
    )


class PriceChange(_PydBase):
    # "set": price = value; "percent": price *= 1 + value/100; "amount": price += value
    mode: Literal["set", "percent", "amount"]
    value: Decimal


class BulkUpdateRequest(_PydBase):
    item_ids: list[str]
    list_price: Optional[PriceChange] = None
    buy_price: Optional[Decimal] = None
    category: Optional[str] = None
    platform: Optional[str] = None
    # Marking sold goes through the sell flow so a sale is recorded.
    status: Optional[Literal["in_stock", "listed"]] = None


class BulkSkipped(_PydBase):
    id: str
    reason: str


class BulkUpdateResponse(_PydBase):
    updated: int
    skipped: list[BulkSkipped] = []


def _apply_price_change(current: Optional[Decimal], change: PriceChange) -> Optional[Decimal]:
    if change.mode == "set":
        new = change.value
    elif current is None:
        return None
    elif change.mode == "percent":
        new = current * (1 + change.value / 100)
    else:
        new = current + change.value
    return max(Decimal("0"), new).quantize(Decimal("0.01"))


@router.post("/bulk-update", response_model=BulkUpdateResponse)
def bulk_update_items(
    payload: BulkUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Edit many inventory items at once (owned + active only).

    Items an edit can't apply to (no list price to adjust by %, a status
    transition the state machine forbids) are skipped and reported, not failed.
    """
    from app.services.inventory import validate_transition

    if not payload.item_ids:
        raise HTTPException(status_code=400, detail="item_ids is required")
    if payload.list_price and payload.list_price.mode == "set" and payload.list_price.value < 0:
        raise HTTPException(status_code=400, detail="Price can't be negative")
    if payload.buy_price is not None and payload.buy_price < 0:
        raise HTTPException(status_code=400, detail="Cost can't be negative")
    if not any([payload.list_price, payload.buy_price is not None, payload.category is not None,
                payload.platform is not None, payload.status]):
        raise HTTPException(status_code=400, detail="Nothing to update")

    updated = 0
    skipped: list[BulkSkipped] = []
    for item_id in payload.item_ids[:500]:
        try:
            item_uuid = UUID(item_id)
        except ValueError:
            skipped.append(BulkSkipped(id=item_id, reason="Not found"))
            continue
        item = (
            db.query(InventoryItem)
            .filter(
                InventoryItem.id == item_uuid,
                InventoryItem.user_id == current_user.id,
                InventoryItem.deleted_at.is_(None),
            )
            .first()
        )
        if not item:
            skipped.append(BulkSkipped(id=item_id, reason="Not found"))
            continue
        if payload.status and item.status != payload.status and not validate_transition(item.status, payload.status):
            skipped.append(BulkSkipped(id=item_id, reason=f"Can't move a {item.status} item to {payload.status}"))
            continue
        if payload.list_price:
            new_price = _apply_price_change(item.expected_sell_price, payload.list_price)
            if new_price is None:
                skipped.append(BulkSkipped(id=item_id, reason="No list price to adjust"))
                continue
            item.expected_sell_price = new_price
        if payload.buy_price is not None:
            item.buy_price = payload.buy_price
        if payload.category is not None:
            item.category = payload.category.strip() or None
        if payload.platform is not None:
            item.platform = payload.platform.strip() or None
        if payload.status:
            item.status = payload.status
        db.add(item)
        _sheet_push(db, item)
        updated += 1
    db.commit()
    return BulkUpdateResponse(updated=updated, skipped=skipped)


@router.patch("/{item_id}/photos", response_model=ItemResponse)
def update_item_photos(
    item_id: UUID,
    payload: PhotoUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update front/back photo (base64 data URL). Called after createItem succeeds."""
    item = _get_active_item(item_id, current_user.id, db)
    if payload.photo_front is not None:
        item.photo_front_url = payload.photo_front
    if payload.photo_back is not None:
        item.photo_back_url = payload.photo_back
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.patch("/{item_id}/status", response_model=ItemResponse)
def update_status(
    item_id: UUID,
    payload: StatusUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Transition item status. Enforces STATE_MACHINES.md transition rules."""
    item = _get_active_item(item_id, current_user.id, db)
    return transition_item(item, payload.status, db)


# ---------------------------------------------------------------------------
# Spreadsheet import endpoints
# ---------------------------------------------------------------------------

def _parse_csv_bytes(content: bytes) -> tuple[list[str], list[dict]]:
    """Return (headers, rows) from raw CSV bytes."""
    try:
        text = content.decode("utf-8-sig")  # handle BOM
    except UnicodeDecodeError:
        text = content.decode("cp1252", errors="replace")  # Excel-on-Windows CSV
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV file has no header row.")
    headers = list(reader.fieldnames)
    rows = list(reader)
    return headers, rows


# Item fields the preview/commit flow can write.
PREVIEW_FIELDS = {
    "name", "category", "sku", "upc", "size", "color", "condition", "buy_price",
    "expected_sell_price", "actual_sell_price", "quantity", "vendor_name", "notes",
    "platform", "photo_front_url", "photo_back_url", "_import_id",
}


def _detect_mapping(headers: list[str]) -> dict[str, str]:
    """Map spreadsheet column names to item fields.

    Known exact names first, then the importer's wide alias list ("Style
    Code", "Retail", "On Hand", "Colour", ...). One column per field: a column
    named exactly like the field wins, otherwise the first one does.
    """
    mapping: dict[str, str] = {}
    exact: dict[str, bool] = {}
    for h in headers:
        if str(h).startswith("__"):
            continue
        key = str(h).strip().lower()
        canonical = IMPORT_HEADER_MAP.get(key) or resolve_field(h)
        if canonical not in PREVIEW_FIELDS:
            continue
        is_exact = normalize_header(h) == normalize_header(canonical)
        owner = next((col for col, c in mapping.items() if c == canonical), None)
        if owner is not None:
            if exact[owner] or not is_exact:
                continue
            del mapping[owner]
        mapping[h] = canonical
        exact[h] = is_exact
    return mapping


DECIMAL_FIELDS = {"buy_price", "expected_sell_price", "actual_sell_price"}
INT_FIELDS = {"quantity"}
PHOTO_URL_FIELDS = {"photo_front_url", "photo_back_url"}
# Database column sizes: longer values are trimmed instead of failing the commit.
_FIELD_MAX = {
    col.name: col.type.length
    for col in InventoryItem.__table__.columns
    if getattr(col.type, "length", None)
}


def _coerce_row(raw: dict, mapping: dict[str, str]) -> tuple[dict, Optional[str]]:
    """Map and coerce one spreadsheet row to item field values.

    Uses the importer's forgiving readers: "$1,200.00", "1.234,56 EUR",
    "2.0" or "3 pairs" quantities, IMAGE()/hyperlink photo cells. A row with
    no name is named by its SKU or UPC. A price or quantity that can't be
    read, a negative number, or no name at all flags the row for the seller
    to fix on the review screen; the rest of the import goes ahead. Returns (mapped_data, error_message).
    """
    mapped: dict = {}
    for csv_col, canonical in mapping.items():
        value = raw.get(csv_col)
        if isinstance(value, (list, dict)):
            continue
        raw_val = str(unescape_cell(value) or "").strip()
        if not raw_val:
            continue
        if canonical in DECIMAL_FIELDS:
            amount, warning = parse_money(raw_val)
            if warning and warning.startswith("Negative"):
                return {}, "Prices can't be negative."
            if amount is None:
                return {}, f"Column '{csv_col}': couldn't read the price \"{raw_val}\"."
            mapped[canonical] = float(amount)
        elif canonical in INT_FIELDS:
            if re.fullmatch(r"-\s*\d+(\.\d+)?", raw_val):
                return {}, "Quantity can't be negative."
            quantity, warning = parse_quantity(raw_val)
            if warning and warning.startswith("Could not read"):
                return {}, f"Column '{csv_col}': couldn't read the quantity \"{raw_val}\"."
            mapped[canonical] = quantity
        elif canonical in PHOTO_URL_FIELDS:
            url = extract_url(raw_val)
            if url:
                mapped[canonical] = url
        else:
            limit = _FIELD_MAX.get(canonical)
            mapped[canonical] = raw_val[:limit] if limit else raw_val
    variants = raw.get("__variants")
    if isinstance(variants, list) and variants:
        mapped["_variants"] = variants
    if "name" not in mapped:
        fallback = mapped.get("sku") or mapped.get("upc")
        if not fallback:
            return {}, "Required field 'name' is missing or empty."
        mapped["name"] = fallback
    return mapped, None


# Imports must never fail for being "too big". Files up to the direct limit go
# in one request; anything larger is sent in chunks (Cloudflare caps a single
# request at 100 MB) and reassembled on disk, so the only ceiling is the
# spreadsheet parser's own limit.
DIRECT_IMPORT_UPLOAD_BYTES = 90 * 1024 * 1024
IMPORT_CHUNK_MAX_BYTES = 6 * 1024 * 1024
# .xlsx files are read from disk without opening their pictures, so photo-heavy
# sheets have no practical size limit; this ceiling only guards the server disk.
IMPORT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024 * 1024
IMPORT_DISK_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024
IMPORT_UPLOAD_DIR = Path(tempfile.gettempdir()) / "resqlo-import-uploads"
IMPORT_UPLOAD_TTL_SECONDS = 6 * 3600
SPREADSHEET_EXTENSIONS = (".csv", ".xlsx", ".txt")


def _check_import_filename(filename: str | None) -> str:
    name = (filename or "").strip() or "inventory.csv"
    lower = name.lower()
    if lower.endswith(".xls"):
        raise HTTPException(
            status_code=400,
            detail="Old .xls files can't be read. In Excel, choose File > Save As > .xlsx or .csv and import that.",
        )
    if not lower.endswith(SPREADSHEET_EXTENSIONS):
        raise HTTPException(status_code=400, detail="Choose a .csv or .xlsx spreadsheet.")
    return name


def _stringify_cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, datetime):
        return value.isoformat() if (value.hour or value.minute or value.second) else value.date().isoformat()
    return str(value)


def _spreadsheet_headers_rows(filename: str, content: bytes) -> tuple[list[str], list[dict]]:
    """Headers + string rows from a CSV or XLSX file, for the preview mapper."""
    file_format = detect_format(filename, None, content)
    if file_format != "xlsx" and not content.strip():
        raise HTTPException(status_code=400, detail="CSV file has no header row.")
    return _headers_rows_from_table(_read_spreadsheet(lambda: rows_from_bytes(content, file_format)))


def _read_spreadsheet(read) -> list[dict]:
    try:
        return read()
    except HTTPException:
        raise
    except Exception as exc:  # openpyxl raises many types for damaged files
        raise HTTPException(
            status_code=400,
            detail="Couldn't read this spreadsheet. Re-save it as .xlsx or .csv and try again.",
        ) from exc


def _headers_rows_from_table(table: list[dict]) -> tuple[list[str], list[dict]]:
    headers: list[str] = []
    seen: set[str] = set()
    rows: list[dict] = []
    for row in table:
        clean: dict = {}
        for key, value in row.items():
            if key == "__variants":
                clean[key] = value  # size breakdown from a size-grid sheet
                continue
            if str(key).startswith("__"):
                continue
            clean[key] = _stringify_cell(value)
            if key not in seen:
                seen.add(key)
                headers.append(key)
        rows.append(clean)
    if not headers:
        raise HTTPException(status_code=400, detail="Spreadsheet has no header row.")
    return headers, rows


@router.post("/imports/preview", response_model=ImportPreviewResponse, status_code=status.HTTP_201_CREATED)
async def preview_import(
    file: UploadFile = File(..., description="CSV or XLSX file to preview"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a spreadsheet, parse it, detect column mapping, and return a preview.

    No inventory changes are made.  Call POST /imports/{job_id}/commit to apply.
    Files over the direct limit go through /imports/uploads in chunks.
    """
    filename = _check_import_filename(file.filename)
    content = await _read_upload_limited(file, DIRECT_IMPORT_UPLOAD_BYTES)
    return _build_import_preview(filename, content, db, current_user)


class ImportUploadStart(_PydBase):
    filename: str
    size: int


class ImportUploadChunk(_PydBase):
    index: int
    data: str  # base64


class ImportUploadFinish(_PydBase):
    filename: str


def _upload_path(user: User, upload_id: UUID) -> Path:
    # upload_id is a validated UUID; still confine the path to the upload dir.
    base = os.path.realpath(IMPORT_UPLOAD_DIR)
    full = os.path.normpath(os.path.join(base, f"{user.id}-{UUID(str(upload_id)).hex}.part"))
    if not full.startswith(base + os.sep):  # pragma: no cover - unreachable for a UUID
        raise HTTPException(status_code=400, detail="Invalid upload id.")
    return Path(full)


def _sweep_stale_uploads() -> None:
    if not IMPORT_UPLOAD_DIR.exists():
        return
    cutoff = time.time() - IMPORT_UPLOAD_TTL_SECONDS
    for stale in IMPORT_UPLOAD_DIR.iterdir():
        try:
            if stale.stat().st_mtime < cutoff:
                stale.unlink()
        except OSError:
            pass


@router.post("/imports/uploads", status_code=status.HTTP_201_CREATED)
async def start_import_upload(
    payload: ImportUploadStart,
    current_user: User = Depends(get_current_user),
):
    """Begin a chunked spreadsheet upload for files too big for one request."""
    name = _check_import_filename(payload.filename)
    # A CSV holds no pictures: 500 MB of text is millions of rows.
    limit = IMPORT_UPLOAD_MAX_BYTES if name.lower().endswith(".xlsx") else MAX_CSV_IMPORT_BYTES
    if payload.size > limit:
        limit_mb = limit // (1024 * 1024)
        hint = " Save it as .xlsx instead." if limit < IMPORT_UPLOAD_MAX_BYTES else ""
        raise HTTPException(status_code=413, detail=f"Spreadsheets over {limit_mb} MB can't be imported.{hint}")
    _sweep_stale_uploads()
    IMPORT_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(IMPORT_UPLOAD_DIR).free < payload.size + IMPORT_DISK_HEADROOM_BYTES:
        raise HTTPException(
            status_code=507,
            detail="Resqlo is short on space for a file this big right now. Try again later or contact support.",
        )
    upload_id = uuid.uuid4()
    _upload_path(current_user, upload_id).write_bytes(b"")
    return {"upload_id": str(upload_id), "chunk_bytes": IMPORT_CHUNK_MAX_BYTES}


@router.put("/imports/uploads/{upload_id}")
async def append_import_upload(
    upload_id: UUID,
    payload: ImportUploadChunk,
    current_user: User = Depends(get_current_user),
):
    """Append one chunk. Chunks arrive in order; a retried chunk is ignored."""
    path = _upload_path(current_user, upload_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Upload not found or expired. Pick the file again.")
    try:
        chunk = base64.b64decode(payload.data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Upload chunk is corrupted.") from exc
    if len(chunk) > IMPORT_CHUNK_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Upload chunk is too large.")
    counter = path.with_suffix(".idx")
    received = int(counter.read_text()) if counter.exists() else 0
    if payload.index < received:
        return {"received": received}
    if payload.index != received:
        raise HTTPException(status_code=409, detail=f"Expected chunk {received}.")
    if path.stat().st_size + len(chunk) > IMPORT_UPLOAD_MAX_BYTES:
        path.unlink(missing_ok=True)
        counter.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail="Spreadsheet is larger than Resqlo can import.")
    with path.open("ab") as handle:
        handle.write(chunk)
    counter.write_text(str(received + 1))
    return {"received": received + 1}


@router.post(
    "/imports/uploads/{upload_id}/preview",
    response_model=ImportPreviewResponse,
    status_code=status.HTTP_201_CREATED,
)
async def preview_import_upload(
    upload_id: UUID,
    payload: ImportUploadFinish,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Build the import preview from a completed chunked upload."""
    filename = _check_import_filename(payload.filename)
    path = _upload_path(current_user, upload_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Upload not found or expired. Pick the file again.")
    with path.open("rb") as handle:
        is_xlsx = filename.lower().endswith(".xlsx") or handle.read(2) == b"PK"
    if is_xlsx:
        # Photos take a while: build the preview in the background and let
        # the app poll GET /imports/{job_id} for progress.
        job = InventoryImportJob(
            user_id=current_user.id, status="pending", source="spreadsheet", filename=filename,
            field_mapping={"_progress": {"done": 0, "total": 0}}, total_rows=0,
            rows_created=0, rows_updated=0, rows_skipped=0, rows_errored=0,
        )
        db.add(job)
        db.commit()
        _run_import_job(lambda session: _process_xlsx_upload(session, job.id, current_user.id, path, filename))
        return JSONResponse(status_code=202, content={"job_id": str(job.id), "status": "pending"})
    try:
        if path.stat().st_size > MAX_CSV_IMPORT_BYTES:
            raise HTTPException(status_code=413, detail="CSV files over 500 MB can't be imported. Save it as .xlsx instead.")
        parsed = _spreadsheet_headers_rows(filename, path.read_bytes())
    finally:
        _remove_upload(path)
    return _build_import_preview(filename, b"", db, current_user, parsed=parsed)


def _remove_upload(path: Path) -> None:
    path.unlink(missing_ok=True)
    path.with_suffix(".idx").unlink(missing_ok=True)


def _run_import_job(work) -> None:
    """Run ``work(session)`` on a worker thread with its own DB session."""
    def runner():
        session = SessionLocal()
        try:
            work(session)
        finally:
            session.close()

    threading.Thread(target=runner, name="import-preview", daemon=True).start()


def _process_xlsx_upload(db: Session, job_id, user_id, path: Path, filename: str) -> None:
    job = db.get(InventoryImportJob, job_id)
    user = db.get(User, user_id)
    last = {"at": 0.0}

    def progress(done: int, total: int) -> None:
        now = time.monotonic()
        if done != total and now - last["at"] < 1.0:
            return
        last["at"] = now
        job.field_mapping = {"_progress": {"done": done, "total": total}}
        db.commit()

    try:
        parsed = _headers_rows_from_table(
            _read_spreadsheet(lambda: xlsx_rows_from_path(str(path), on_progress=progress))
        )
        _build_import_preview(filename, b"", db, user, parsed=parsed, job=job)
    except Exception as exc:  # report every failure on the job instead of losing it
        db.rollback()
        detail = exc.detail if isinstance(exc, HTTPException) else "Couldn't read this spreadsheet. Re-save it as .xlsx and try again."
        if not isinstance(exc, HTTPException):
            logger.exception("Import preview failed for job %s", job_id)
        job = db.get(InventoryImportJob, job_id)
        job.status = "failed"
        job.field_mapping = {"_error": str(detail)}
        db.commit()
    finally:
        _remove_upload(path)


def _build_import_preview(
    filename: str,
    content: bytes,
    db: Session,
    current_user: User,
    parsed: tuple[list[str], list[dict]] | None = None,
    job: InventoryImportJob | None = None,
) -> ImportPreviewResponse:
    headers, raw_rows = parsed or _spreadsheet_headers_rows(filename, content)
    file = SimpleNamespace(filename=filename)
    detected_mapping = _detect_mapping(headers)

    # Persist the job in 'pending' state
    new_job = job is None
    if new_job:
        job = InventoryImportJob(user_id=current_user.id, source="spreadsheet")
    job.status = "pending"
    job.filename = file.filename
    job.field_mapping = detected_mapping
    job.total_rows = len(raw_rows)
    job.rows_created = job.rows_updated = job.rows_skipped = job.rows_errored = 0
    db.add(job)
    db.flush()  # get job.id

    preview_rows: list[ImportRowResult] = []
    counts = {"create": 0, "update": 0, "skip": 0, "error": 0}

    # Build lookups of existing items by SKU and by id for the current user.
    # SKU match is preferred; id match (from re-imported export) is the fallback
    # so items without a SKU are updated rather than duplicated on round-trip.
    existing_by_sku: dict[str, list[InventoryItem]] = {}
    existing_by_id: dict[str, InventoryItem] = {}
    all_items = db.query(InventoryItem).filter(
        InventoryItem.user_id == current_user.id,
        InventoryItem.deleted_at.is_(None),
    ).all()
    for it in all_items:
        if it.sku:
            existing_by_sku.setdefault(_sku_key(it.sku), []).append(it)
        existing_by_id[str(it.id)] = it

    for row_num, raw in enumerate(raw_rows, start=1):
        mapped, error = _coerce_row(raw, detected_mapping)
        row_id = uuid.uuid4()

        if error:
            action = "error"
            counts["error"] += 1
            row_result = ImportRowResult(
                row_number=row_num, action=action, error_message=error,
                mapped_data=None,
            )
        else:
            sku = (mapped.get("sku") or "").lower()
            import_id = (mapped.pop("_import_id", None) or "").strip()
            existing = _match_existing(existing_by_sku.get(_sku_key(sku), []), mapped.get("size")) if sku else None
            match_key, match_value = "sku", mapped.get("sku")
            if not existing and import_id:
                existing = existing_by_id.get(import_id)
                match_key, match_value = "id", import_id
            if existing:
                action = "update"
                counts["update"] += 1
                row_result = ImportRowResult(
                    row_number=row_num, action=action,
                    inventory_item_id=existing.id,
                    mapped_data=mapped,
                    match_key=match_key, match_value=match_value,
                )
            else:
                action = "create"
                counts["create"] += 1
                row_result = ImportRowResult(
                    row_number=row_num, action=action, mapped_data=mapped,
                )

        row_result.id = row_id
        preview_rows.append(row_result)

        db.add(InventoryImportRow(
            id=row_id,
            job_id=job.id,
            row_number=row_num,
            action=action,
            inventory_item_id=row_result.inventory_item_id,
            raw_data=_without_photos(raw),
            mapped_data=mapped or None,
            error_message=error,
            match_key=row_result.match_key,
            match_value=row_result.match_value,
        ))

    job.status = "previewed"
    job.rows_created = counts["create"]
    job.rows_updated = counts["update"]
    job.rows_skipped = counts["skip"]
    job.rows_errored = counts["error"]
    db.add(job)
    db.commit()

    return ImportPreviewResponse(
        job_id=job.id,
        status=job.status,
        filename=job.filename,
        detected_mapping=detected_mapping,
        rows=_slim_preview_rows(preview_rows),
        total_rows=job.total_rows,
        rows_to_create=counts["create"],
        rows_to_update=counts["update"],
        rows_to_skip=counts["skip"],
        rows_errored=counts["error"],
    )


PHOTO_FIELDS = ("photo_front_url", "photo_back_url")
# The review screen shows the first rows with their pictures; later rows keep
# their photos server-side (they still import) but are sent without them so a
# sheet with thousands of photos doesn't become a huge download to the phone.
PREVIEW_PHOTO_ROWS = 100


def _is_data_image(value) -> bool:
    return isinstance(value, str) and value.startswith("data:image/")


def _without_photos(raw: dict) -> dict:
    return {k: ("[photo]" if _is_data_image(v) else v) for k, v in raw.items()}


def _slim_preview_rows(rows: list[ImportRowResult]) -> list[ImportRowResult]:
    out = []
    for index, row in enumerate(rows):
        if index >= PREVIEW_PHOTO_ROWS and row.mapped_data and any(_is_data_image(v) for v in row.mapped_data.values()):
            row = row.model_copy(update={
                "mapped_data": {k: v for k, v in row.mapped_data.items() if not _is_data_image(v)},
            })
        out.append(row)
    return out


@router.get("/imports/{job_id}/preview", response_model=ImportPreviewResponse)
def get_import_preview(
    job_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The preview of a job built in the background, once it's ready."""
    job = _get_previewed_job(job_id, current_user.id, db)
    rows = db.query(InventoryImportRow).filter(
        InventoryImportRow.job_id == job.id,
    ).order_by(InventoryImportRow.row_number).all()
    results = [_row_result(row) for row in rows]
    actions = [row.action for row in rows]
    return ImportPreviewResponse(
        job_id=job.id,
        status=job.status,
        filename=job.filename,
        detected_mapping=job.field_mapping or {},
        rows=_slim_preview_rows(results),
        total_rows=job.total_rows,
        rows_to_create=actions.count("create"),
        rows_to_update=actions.count("update"),
        rows_to_skip=actions.count("skip"),
        rows_errored=actions.count("error"),
    )


# Fields the review screen may edit on a previewed row. Same canonical names
# the CSV mapper produces; internal keys (``_import_id``) are not editable.
EDITABLE_IMPORT_FIELDS = {
    "name", "category", "sku", "upc", "size", "color", "condition", "quantity",
    "buy_price", "expected_sell_price", "actual_sell_price", "vendor_name",
    "notes", "platform", "photo_front_url", "photo_back_url",
}


def _get_previewed_job(job_id: UUID, user_id, db: Session) -> InventoryImportJob:
    job = db.query(InventoryImportJob).filter(
        InventoryImportJob.id == job_id,
        InventoryImportJob.user_id == user_id,
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Import job not found.")
    if job.status != "previewed":
        raise HTTPException(
            status_code=400,
            detail=f"Job status is '{job.status}'. Only 'previewed' jobs can be changed.",
        )
    return job


def _remember_imported(db: Session, user_id, items: list[InventoryItem]) -> None:
    """Teach Smart Scan and the Resqlo catalog from imported items.

    A side benefit only: if it fails, the import itself still goes through.
    """
    try:
        with db.begin_nested():
            remember_items(db, user_id, items)
    except Exception:
        logger.warning("Import: scan memory update skipped", exc_info=True)


def _sku_key(sku: str) -> str:
    return (sku or "").strip().lower()


def _size_key(size) -> str:
    text = " ".join(str(size or "").lower().split())
    for prefix in ("us ", "size "):
        if text.startswith(prefix):
            text = text[len(prefix):]
    return text


def _match_existing(candidates: list[InventoryItem], size) -> Optional[InventoryItem]:
    """The existing item a row updates: same SKU *and* size.

    Stores often give every size of a shoe the same SKU (the style code), one
    row per size, so a SKU alone would make every size row overwrite one
    item. A row without a size matches only when that SKU is a single item.
    """
    if not candidates:
        return None
    wanted = _size_key(size)
    exact = [item for item in candidates if _size_key(item.size) == wanted]
    if exact:
        return exact[-1]
    if not wanted and len(candidates) == 1:
        return candidates[0]
    return None


def _resolve_row_action(row: InventoryImportRow, mapped: dict, user_id, db: Session) -> None:
    """Re-run the preview's create/update decision for an edited row."""
    sku = (mapped.get("sku") or "").strip()
    existing = None
    if sku:
        same_sku = db.query(InventoryItem).filter(
            InventoryItem.user_id == user_id,
            InventoryItem.deleted_at.is_(None),
            func.lower(InventoryItem.sku) == sku.lower(),
        ).all()
        existing = _match_existing(same_sku, mapped.get("size"))
    if existing:
        row.action, row.inventory_item_id = "update", existing.id
        row.match_key, row.match_value = "sku", sku
        return
    if row.match_key == "id" and row.inventory_item_id:
        still_there = db.query(InventoryItem.id).filter(
            InventoryItem.id == row.inventory_item_id,
            InventoryItem.user_id == user_id,
            InventoryItem.deleted_at.is_(None),
        ).first()
        if still_there:
            row.action = "update"
            return
    row.action, row.inventory_item_id = "create", None
    row.match_key = row.match_value = None


def _recount_job(job: InventoryImportJob, db: Session) -> None:
    rows = db.query(InventoryImportRow.action).filter(InventoryImportRow.job_id == job.id).all()
    actions = [r[0] for r in rows]
    job.rows_created = actions.count("create")
    job.rows_updated = actions.count("update")
    job.rows_skipped = actions.count("skip")
    job.rows_errored = actions.count("error")


@router.patch("/imports/{job_id}/rows/{row_id}", response_model=ImportRowResult)
def update_import_row(
    job_id: UUID,
    row_id: UUID,
    payload: ImportRowUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Edit or discard one row of a previewed import before committing.

    Edits are validated with the same rules the CSV importer applies; a row
    that fails validation becomes an ``error`` row and is not imported unless
    fixed. ``skip: true`` discards the row; ``skip: false`` restores it.
    """
    job = _get_previewed_job(job_id, current_user.id, db)
    row = db.query(InventoryImportRow).filter(
        InventoryImportRow.id == row_id,
        InventoryImportRow.job_id == job.id,
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Import row not found.")

    if payload.data is not None:
        unknown = sorted(set(payload.data) - EDITABLE_IMPORT_FIELDS)
        if unknown:
            raise HTTPException(status_code=422, detail=f"Unknown field(s): {', '.join(unknown)}")
        kept_photos = {
            k: v for k, v in (row.mapped_data or {}).items()
            if k in PHOTO_FIELDS and k not in payload.data and v
        }
        as_text = {k: "" if v is None else str(v) for k, v in payload.data.items()}
        mapped, error = _coerce_row(as_text, {k: k for k in as_text})
        if not error and mapped.get("quantity") is not None and mapped["quantity"] < 0:
            mapped, error = {}, "Quantity can't be negative."
        if not error and any(mapped.get(f) is not None and mapped[f] < 0 for f in DECIMAL_FIELDS):
            mapped, error = {}, "Prices can't be negative."
        row.error_message = error
        if error:
            row.action = "error"
            # Keep what the seller typed so they can fix it from the same sheet.
            row.mapped_data = {**{k: v for k, v in payload.data.items() if v not in (None, "")}, **kept_photos}
        else:
            mapped.update(kept_photos)
            row.mapped_data = mapped
            _resolve_row_action(row, mapped, current_user.id, db)

    if payload.skip is True:
        row.action = "skip"
    elif payload.skip is False and row.action == "skip":
        if row.error_message or not row.mapped_data:
            row.action = "error"
        else:
            _resolve_row_action(row, row.mapped_data, current_user.id, db)

    db.add(row)
    db.flush()
    _recount_job(job, db)
    db.add(job)
    db.commit()
    db.refresh(row)
    return _row_result(row)


def _row_result(row: InventoryImportRow) -> ImportRowResult:
    return ImportRowResult(
        id=row.id,
        row_number=row.row_number,
        action=row.action,
        inventory_item_id=row.inventory_item_id,
        mapped_data=row.mapped_data,
        match_key=row.match_key,
        match_value=row.match_value,
        error_message=row.error_message,
    )


@router.post("/imports/{job_id}/commit", response_model=ImportCommitResponse)
def commit_import(
    job_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Apply a previewed import job.  Only callable once per job.

    Creates or updates InventoryItem records based on the previewed rows.
    """

    job = db.query(InventoryImportJob).filter(
        InventoryImportJob.id == job_id,
        InventoryImportJob.user_id == current_user.id,
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Import job not found.")
    if job.status != "previewed":
        raise HTTPException(
            status_code=400,
            detail=f"Job status is '{job.status}'. Only 'previewed' jobs can be committed.",
        )

    import_rows = db.query(InventoryImportRow).filter(
        InventoryImportRow.job_id == job.id,
    ).order_by(InventoryImportRow.row_number).all()

    counts = {"create": 0, "update": 0, "skip": 0, "error": 0}
    touched: list[InventoryItem] = []

    for row in import_rows:
        if row.action == "error" or not row.mapped_data:
            counts["skip"] += 1
            continue

        mapped = row.mapped_data

        if row.action == "create":
            item = InventoryItem(
                user_id=current_user.id,
                name=mapped.get("name", ""),
                category=mapped.get("category"),
                sku=mapped.get("sku"),
                upc=mapped.get("upc"),
                size=mapped.get("size"),
                color=mapped.get("color"),
                condition=mapped.get("condition"),
                buy_price=mapped.get("buy_price"),
                expected_sell_price=mapped.get("expected_sell_price"),
                actual_sell_price=mapped.get("actual_sell_price"),
                quantity=int(mapped["quantity"]) if mapped.get("quantity") is not None else 1,
                custom_attributes={"variants": mapped["_variants"]} if mapped.get("_variants") else {},
                vendor_name=mapped.get("vendor_name"),
                notes=mapped.get("notes"),
                platform=mapped.get("platform"),
                photo_front_url=mapped.get("photo_front_url"),
                photo_back_url=mapped.get("photo_back_url"),
                source="spreadsheet",
                status="in_stock",
            )
            db.add(item)
            touched.append(item)
            counts["create"] += 1

        elif row.action == "update" and row.inventory_item_id:
            item = db.query(InventoryItem).filter(
                InventoryItem.id == row.inventory_item_id,
                InventoryItem.user_id == current_user.id,
                InventoryItem.deleted_at.is_(None),
            ).first()
            if not item:
                counts["skip"] += 1
                continue

            # Write a ledger entry for quantity changes
            new_qty = int(mapped["quantity"]) if mapped.get("quantity") is not None else item.quantity
            delta = new_qty - item.quantity
            if delta != 0:
                ledger = InventoryStockLedger(
                    inventory_item_id=item.id,
                    user_id=current_user.id,
                    delta_quantity=delta,
                    quantity_after=new_qty,
                    event_type="import_adjust",
                    source_type="import_job",
                    source_id=str(job.id),
                    idempotency_key=f"import:{job.id}:row:{row.row_number}:qty",
                )
                db.add(ledger)

            # Apply all mapped fields (skip internal import-only keys)
            _SKIP_ON_UPDATE = {"_import_id", "_variants"}
            for field, value in mapped.items():
                if field not in _SKIP_ON_UPDATE and hasattr(item, field):
                    setattr(item, field, value)
            if mapped.get("_variants"):
                item.custom_attributes = {**(item.custom_attributes or {}), "variants": mapped["_variants"]}
            db.add(item)
            touched.append(item)
            counts["update"] += 1
        else:
            counts["skip"] += 1

    # Rows with a barcode + name teach Smart Scan (never over seller-confirmed memory).
    _remember_imported(db, current_user.id, touched)

    job.status = "committed"
    job.rows_created = counts["create"]
    job.rows_updated = counts["update"]
    job.rows_skipped = counts["skip"]
    db.add(job)
    db.commit()

    return ImportCommitResponse(
        job_id=job.id,
        status="committed",
        rows_created=counts["create"],
        rows_updated=counts["update"],
        rows_skipped=counts["skip"],
        rows_errored=counts["error"],
    )


@router.get("/imports/{job_id}", response_model=ImportJobResponse)
def get_import_job(
    job_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get the status and summary of an import job."""
    job = db.query(InventoryImportJob).filter(
        InventoryImportJob.id == job_id,
        InventoryImportJob.user_id == current_user.id,
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Import job not found.")
    meta = job.field_mapping if isinstance(job.field_mapping, dict) else {}
    out = ImportJobResponse.model_validate(job)
    out.progress = meta.get("_progress") if job.status == "pending" else None
    out.error = meta.get("_error") if job.status == "failed" else None
    if out.progress is not None or out.error is not None:
        out.field_mapping = None
    return out
