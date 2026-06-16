"""Inventory router — /api/v1/inventory endpoints.

Soft-delete 404 rule: All GET/PUT/PATCH filter WHERE deleted_at IS NULL.
Soft-deleted records return 404, never exposed.
"""
import csv
import io
import ipaddress
import math
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
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
    ImportCommitResponse,
    InventoryActivityEntry,
    InventoryImportRequest,
    InventoryImportResult,
)
from app.dependencies.auth import get_current_user
from app.dependencies.tier_limiter import TIER_LIMITS, enforce_item_limit
from app.services.inventory import transition_item, get_available_quantity
from app.services.spreadsheet_import import (
    detect_format,
    google_sheet_candidate_csv_urls,
    google_sheet_export_urls,
    google_sheet_csv_url,
    parse_inventory_rows,
    rows_from_bytes,
)

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


def _validate_import_host(url: str) -> list[str]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Import link must be a public http(s) spreadsheet URL.",
        )

    host = parsed.hostname.lower()
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Import link must be publicly reachable.",
            )
    except ValueError:
        blocked_hosts = {"localhost", "127.0.0.1", "0.0.0.0"}
        if host in blocked_hosts or host.endswith(".local"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Import link must be publicly reachable.",
            )
    if host in {"docs.google.com", "www.docs.google.com"}:
        return google_sheet_export_urls(url)
    return [google_sheet_csv_url(url)]


def _find_import_match(
    db: Session,
    user_id,
    payload: dict,
    external_id: str,
) -> InventoryItem | None:
    if payload.get("upc"):
        match = db.query(InventoryItem).filter(
            InventoryItem.user_id == user_id,
            InventoryItem.deleted_at.is_(None),
            InventoryItem.upc == payload["upc"],
        ).first()
        if match:
            return match
    if payload.get("sku"):
        match = db.query(InventoryItem).filter(
            InventoryItem.user_id == user_id,
            InventoryItem.deleted_at.is_(None),
            InventoryItem.sku == payload["sku"],
        ).first()
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
        match = _find_import_match(db, current_user.id, parsed_row.payload, parsed_row.external_id)
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
        else:
            item = InventoryItem(
                user_id=current_user.id,
                source="spreadsheet",
                external_id=parsed_row.external_id,
                custom_attributes=raw_attrs,
                **payload,
            )
            db.add(item)

    if not dry_run:
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
    db.commit()
    db.refresh(item)
    return item


@router.get("", response_model=PaginatedItems)
def list_items(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    q: Optional[str] = Query(None, description="Search by name, SKU, or UPC"),
    status_filter: Optional[str] = Query(None, alias="status", description="Filter by status"),
    source_filter: Optional[str] = Query(None, alias="source", description="Filter by source (e.g. lightspeed)"),
    available_only: bool = Query(False, description="Only items with quantity > 0 and status in (in_stock, listed)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List inventory items with pagination and optional search/filters."""
    base_query = db.query(InventoryItem).filter(
        InventoryItem.user_id == current_user.id,
        InventoryItem.deleted_at.is_(None),
    )

    if q:
        term = f"%{q[:50]}%"  # cap at 50 chars for safety
        base_query = base_query.filter(
            or_(
                InventoryItem.name.ilike(term),
                InventoryItem.sku.ilike(term),
                InventoryItem.upc.ilike(term),
            )
        )

    if status_filter:
        base_query = base_query.filter(InventoryItem.status == status_filter)

    if source_filter:
        base_query = base_query.filter(InventoryItem.source == source_filter)

    if available_only:
        base_query = base_query.filter(
            InventoryItem.status.in_(["in_stock", "listed"]),
            InventoryItem.quantity > 0,
        )

    total = base_query.count()
    items = (
        base_query
        .order_by(InventoryItem.created_at.desc())
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

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=headers) as client:
        for import_url in import_urls:
            try:
                response = await client.get(import_url)
                response.raise_for_status()
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
                    filename=urlparse(import_url).path,
                    content_type=response.headers.get("content-type"),
                    content=response.content,
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
                    discovery_text = response.text
                    try:
                        discovery_response = await client.get(payload.url)
                        if discovery_response.status_code < 400:
                            discovery_text = discovery_response.text
                    except httpx.HTTPError:
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
    content = await file.read()
    return _import_inventory_content(
        filename=file.filename or "inventory.csv",
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
    """Market price lookup. Queries UPC database + internal Vendora history."""
    result: dict = {"query": query, "upc": upc, "product_info": None, "sources": []}

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
                        "name": i.get("title"),
                        "brand": i.get("brand"),
                        "category": i.get("category"),
                        "images": (i.get("images") or [])[:2],
                    }
                    prices = [
                        float(o["price"])
                        for o in i.get("offers", [])
                        if o.get("price") and float(o.get("price", 0)) > 0
                    ]
                    if prices:
                        result["sources"].append({
                            "source": "retail",
                            "label": "Retail prices",
                            "low": round(min(prices), 2),
                            "high": round(max(prices), 2),
                            "avg": round(sum(prices) / len(prices), 2),
                            "count": len(prices),
                        })
        except Exception:
            pass  # graceful degradation

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
        result["sources"].append({
            "source": "vendora_history",
            "label": "Your avg sell price",
            "avg": round(float(name_avg), 2),
        })

    return result


@router.get("/{item_id}/pricing-suggestion")
def get_pricing_suggestion(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Smart pricing suggestion using own sales history and buy price margin."""
    item = _get_active_item(item_id, current_user.id, db)

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
    elif category_avg:
        suggested = round(float(category_avg), 2)
        reason = f"Based on your {item.category} category average"
    elif margin_30:
        suggested = margin_30
        reason = "30% margin over your buy price"
    else:
        suggested = None
        reason = "Add more sales data to unlock smart suggestions"

    return {
        "item_id": str(item.id),
        "current_expected": float(item.expected_sell_price) if item.expected_sell_price else None,
        "suggested_price": suggested,
        "reason": reason,
        "category_avg": round(float(category_avg), 2) if category_avg else None,
        "name_avg": round(float(name_avg), 2) if name_avg else None,
        "margin_30_percent": margin_30,
    }


@router.get("/{item_id}", response_model=ItemResponse)
def get_item(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single inventory item. Returns 404 if deleted or not owned."""
    return _get_active_item(item_id, current_user.id, db)


@router.get("/{item_id}/activity", response_model=list[InventoryActivityEntry])
def get_item_activity(
    item_id: str,
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
    item_id: str,
    payload: ItemUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update an inventory item. Cannot update status here — use PATCH /status."""
    item = _get_active_item(item_id, current_user.id, db)

    update_data = payload.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(item, field, value)

    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(
    item_id: str,
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


@router.patch("/{item_id}/photos", response_model=ItemResponse)
def update_item_photos(
    item_id: str,
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
    item_id: str,
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
    text = content.decode("utf-8-sig", errors="replace")  # handle BOM
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV file has no header row.")
    headers = list(reader.fieldnames)
    rows = list(reader)
    return headers, rows


def _detect_mapping(headers: list[str]) -> dict[str, str]:
    """Map CSV column names to canonical InventoryItem fields."""
    mapping: dict[str, str] = {}
    for h in headers:
        canonical = IMPORT_HEADER_MAP.get(h.strip().lower())
        if canonical:
            mapping[h] = canonical
    return mapping


DECIMAL_FIELDS = {"buy_price", "expected_sell_price", "actual_sell_price"}
INT_FIELDS = {"quantity"}


def _coerce_row(raw: dict, mapping: dict[str, str]) -> tuple[dict, Optional[str]]:
    """Map and coerce a raw CSV row to InventoryItem field values.

    Returns (mapped_data, error_message).  mapped_data is empty on error.
    """
    mapped: dict = {}
    for csv_col, canonical in mapping.items():
        raw_val = (raw.get(csv_col) or "").strip()
        if not raw_val:
            continue
        try:
            if canonical in DECIMAL_FIELDS:
                # Strip currency symbols
                mapped[canonical] = float(raw_val.replace("$", "").replace(",", ""))
            elif canonical in INT_FIELDS:
                mapped[canonical] = int(raw_val)
            else:
                mapped[canonical] = raw_val
        except (ValueError, TypeError) as exc:
            return {}, f"Column '{csv_col}': {exc}"
    if "name" not in mapped:
        return {}, "Required field 'name' is missing or empty."
    return mapped, None


@router.post("/imports/preview", response_model=ImportPreviewResponse, status_code=status.HTTP_201_CREATED)
async def preview_import(
    file: UploadFile = File(..., description="CSV file to preview"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a CSV, parse it, detect column mapping, and return a preview.

    No inventory changes are made.  Call POST /imports/{job_id}/commit to apply.
    """
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only .csv files are accepted.")

    content = await file.read()
    if len(content) > 5 * 1024 * 1024:  # 5 MB cap
        raise HTTPException(status_code=400, detail="CSV file must be smaller than 5 MB.")

    headers, raw_rows = _parse_csv_bytes(content)
    detected_mapping = _detect_mapping(headers)

    # Persist the job in 'pending' state
    job = InventoryImportJob(
        user_id=current_user.id,
        status="pending",
        source="spreadsheet",
        filename=file.filename,
        field_mapping=detected_mapping,
        total_rows=len(raw_rows),
        rows_created=0,
        rows_updated=0,
        rows_skipped=0,
        rows_errored=0,
    )
    db.add(job)
    db.flush()  # get job.id

    preview_rows: list[ImportRowResult] = []
    counts = {"create": 0, "update": 0, "skip": 0, "error": 0}

    # Build lookups of existing items by SKU and by id for the current user.
    # SKU match is preferred; id match (from re-imported export) is the fallback
    # so items without a SKU are updated rather than duplicated on round-trip.
    existing_by_sku: dict[str, InventoryItem] = {}
    existing_by_id: dict[str, InventoryItem] = {}
    all_items = db.query(InventoryItem).filter(
        InventoryItem.user_id == current_user.id,
        InventoryItem.deleted_at.is_(None),
    ).all()
    for it in all_items:
        if it.sku:
            existing_by_sku[it.sku.lower()] = it
        existing_by_id[str(it.id)] = it

    for row_num, raw in enumerate(raw_rows, start=1):
        mapped, error = _coerce_row(raw, detected_mapping)

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
            existing = existing_by_sku.get(sku) if sku else None
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

        preview_rows.append(row_result)

        db.add(InventoryImportRow(
            job_id=job.id,
            row_number=row_num,
            action=action,
            inventory_item_id=row_result.inventory_item_id,
            raw_data=dict(raw),
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
        rows=preview_rows,
        total_rows=job.total_rows,
        rows_to_create=counts["create"],
        rows_to_update=counts["update"],
        rows_to_skip=counts["skip"],
        rows_errored=counts["error"],
    )


@router.post("/imports/{job_id}/commit", response_model=ImportCommitResponse)
def commit_import(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Apply a previewed import job.  Only callable once per job.

    Creates or updates InventoryItem records based on the previewed rows.
    """
    from app.services.inventory import restore_stock  # local import to avoid circular

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
                quantity=int(mapped.get("quantity") or 1),
                vendor_name=mapped.get("vendor_name"),
                notes=mapped.get("notes"),
                platform=mapped.get("platform"),
                photo_front_url=mapped.get("photo_front_url"),
                photo_back_url=mapped.get("photo_back_url"),
                source="spreadsheet",
                status="in_stock",
            )
            db.add(item)
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
            new_qty = int(mapped.get("quantity") or item.quantity)
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
            _SKIP_ON_UPDATE = {"_import_id"}
            for field, value in mapped.items():
                if field not in _SKIP_ON_UPDATE and hasattr(item, field):
                    setattr(item, field, value)
            db.add(item)
            counts["update"] += 1
        else:
            counts["skip"] += 1

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
    job_id: str,
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
    return job
