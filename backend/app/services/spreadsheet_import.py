"""Spreadsheet inventory import helpers.

Accepts messy reseller spreadsheets and maps common column names into the
Vendora inventory model. The router owns authentication and persistence.
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

from fastapi import HTTPException, status


MAX_IMPORT_BYTES = 8 * 1024 * 1024

FIELD_ALIASES: dict[str, set[str]] = {
    "name": {"name", "item", "itemname", "title", "product", "productname", "description"},
    "category": {"category", "type", "department", "collection"},
    "sku": {"sku", "style", "stylecode", "stocknumber", "itemnumber", "itemid"},
    "upc": {"upc", "barcode", "ean", "gtin"},
    "size": {"size", "shoe size", "shoesize", "variant", "variantsize"},
    "color": {"color", "colour"},
    "condition": {"condition", "grade"},
    "serial_number": {"serial", "serialnumber", "imei", "watchserial"},
    "buy_price": {"buyprice", "cost", "costbasis", "purchaseprice", "paid", "wholesale"},
    "expected_sell_price": {"expectedprice", "sellprice", "listprice", "price", "askingprice", "retail"},
    "actual_sell_price": {"soldprice", "actualsellprice", "saleprice"},
    "platform": {"platform", "marketplace", "listedon", "channel"},
    "quantity": {"qty", "quantity", "stock", "count", "onhand", "inventory"},
    "vendor_name": {"vendor", "supplier", "source", "purchasedfrom"},
    "notes": {"notes", "note", "memo", "details"},
    "photo_front_url": {"photo", "image", "imageurl", "image_url", "picture", "frontphoto", "photourl"},
    "photo_back_url": {"backphoto", "backimage", "backimageurl", "secondaryimage"},
    "brand": {"brand", "maker", "designer"},
    "status": {"status", "state"},
}

VALID_STATUSES = {"in_stock", "listed", "sold", "shipped", "paid", "archived"}
STATUS_ALIASES = {
    "instock": "in_stock",
    "available": "in_stock",
    "active": "in_stock",
    "for sale": "listed",
    "forsale": "listed",
    "listed": "listed",
    "sold": "sold",
    "shipped": "shipped",
    "paid": "paid",
    "archived": "archived",
}


@dataclass
class ParsedImportRow:
    row_number: int
    payload: dict[str, Any]
    external_id: str
    raw: dict[str, Any]
    warnings: list[str]


def normalize_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def resolve_field(header: str) -> str | None:
    normalized = normalize_header(header)
    for field, aliases in FIELD_ALIASES.items():
        if normalized in {normalize_header(alias) for alias in aliases}:
            return field
    return None


def decimal_string(value: Any) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", raw)
    if not cleaned or cleaned in {"-", "."}:
        return None
    try:
        amount = Decimal(cleaned)
    except InvalidOperation:
        return None
    if amount < 0:
        return None
    return f"{amount.quantize(Decimal('0.01'))}"


def int_value(value: Any) -> int:
    raw = str(value or "").strip()
    if not raw:
        return 1
    match = re.search(r"\d+", raw)
    if not match:
        return 1
    return max(1, int(match.group(0)))


def status_value(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return "in_stock"
    normalized = re.sub(r"[_\-]+", " ", raw)
    compact = normalize_header(raw)
    if raw in VALID_STATUSES:
        return raw
    return STATUS_ALIASES.get(normalized) or STATUS_ALIASES.get(compact) or "in_stock"


def looks_like_url(value: Any) -> bool:
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def google_sheet_csv_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.netloc not in {"docs.google.com", "www.docs.google.com"}:
        return url
    match = re.search(r"/spreadsheets/d/([^/]+)", parsed.path)
    if not match:
        return url
    qs = parse_qs(parsed.query)
    gid = qs.get("gid", ["0"])[0]
    query = urlencode({"format": "csv", "gid": gid})
    return f"https://docs.google.com/spreadsheets/d/{match.group(1)}/export?{query}"


def detect_format(filename: str | None, content_type: str | None, content: bytes) -> str:
    name = (filename or "").lower()
    ctype = (content_type or "").lower()
    if name.endswith(".xlsx") or "spreadsheetml" in ctype or content.startswith(b"PK"):
        return "xlsx"
    return "csv"


def rows_from_bytes(content: bytes, file_format: str) -> list[dict[str, Any]]:
    if len(content) > MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Spreadsheet is too large. Import files must be 8 MB or less.",
        )

    if file_format == "xlsx":
        try:
            from openpyxl import load_workbook
        except ImportError as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="XLSX import support is not installed on the server.",
            ) from exc

        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        sheet = workbook.active
        iterator = sheet.iter_rows(values_only=True)
        headers = [str(cell or "").strip() for cell in next(iterator, [])]
        return [
            {headers[idx]: value for idx, value in enumerate(row) if idx < len(headers)}
            for row in iterator
            if any(value not in (None, "") for value in row)
        ]

    text = content.decode("utf-8-sig", errors="replace")
    sample = text[:2048]
    try:
        dialect = csv.Sniffer().sniff(sample) if sample.strip() else csv.excel
    except csv.Error:
        dialect = csv.excel
    return [dict(row) for row in csv.DictReader(io.StringIO(text), dialect=dialect)]


def parse_inventory_rows(rows: list[dict[str, Any]]) -> list[ParsedImportRow]:
    parsed_rows: list[ParsedImportRow] = []

    for idx, raw in enumerate(rows, start=2):
        mapped: dict[str, Any] = {}
        custom_attributes: dict[str, Any] = {}
        warnings: list[str] = []

        for header, value in raw.items():
            if value is None or str(value).strip() == "":
                continue
            field = resolve_field(header)
            if not field:
                custom_attributes[normalize_header(header) or str(header)] = value
                continue
            mapped[field] = str(value).strip()

        if not mapped.get("name"):
            brand = mapped.get("brand")
            sku = mapped.get("sku") or mapped.get("upc")
            category = mapped.get("category")
            mapped["name"] = " ".join(part for part in [brand, category, sku] if part).strip()

        if not mapped.get("name"):
            warnings.append("Skipped row without item name or usable identifier.")
            parsed_rows.append(
                ParsedImportRow(idx, {}, "", raw, warnings)
            )
            continue

        payload: dict[str, Any] = {
            "name": mapped["name"][:255],
            "category": mapped.get("category"),
            "sku": mapped.get("sku"),
            "upc": mapped.get("upc"),
            "size": mapped.get("size"),
            "color": mapped.get("color"),
            "condition": mapped.get("condition"),
            "serial_number": mapped.get("serial_number"),
            "buy_price": decimal_string(mapped.get("buy_price")),
            "expected_sell_price": decimal_string(mapped.get("expected_sell_price")),
            "actual_sell_price": decimal_string(mapped.get("actual_sell_price")),
            "platform": mapped.get("platform"),
            "quantity": int_value(mapped.get("quantity")),
            "vendor_name": mapped.get("vendor_name"),
            "notes": mapped.get("notes"),
            "status": status_value(mapped.get("status")),
        }

        if mapped.get("brand"):
            custom_attributes["brand"] = mapped["brand"]
        if looks_like_url(mapped.get("photo_front_url")):
            payload["photo_front_url"] = mapped["photo_front_url"]
        elif mapped.get("photo_front_url"):
            warnings.append("Ignored photo column because it was not a direct http(s) URL.")
        if looks_like_url(mapped.get("photo_back_url")):
            payload["photo_back_url"] = mapped["photo_back_url"]

        custom_attributes["import_raw"] = {
            str(k): v for k, v in raw.items() if v not in (None, "")
        }
        payload["custom_attributes"] = custom_attributes
        payload = {k: v for k, v in payload.items() if v not in (None, "")}

        fingerprint_base = "|".join(
            str(payload.get(field, "")) for field in ("sku", "upc", "name", "size", "color")
        )
        external_id = hashlib.sha256(fingerprint_base.encode("utf-8")).hexdigest()[:32]
        parsed_rows.append(ParsedImportRow(idx, payload, external_id, raw, warnings))

    return parsed_rows
