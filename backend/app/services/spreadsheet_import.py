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
    "photo_front_url": {
        "photo",
        "photos",
        "image",
        "images",
        "imageurl",
        "image_url",
        "imagelink",
        "image link",
        "picture",
        "thumbnail",
        "productimage",
        "product image",
        "frontphoto",
        "front photo",
        "frontimage",
        "front image",
        "frontimageformula",
        "front image formula",
        "photourl",
        "photo url",
    },
    "photo_back_url": {"backphoto", "back photo", "backimage", "back image", "backimageurl", "secondaryimage"},
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
URL_RE = re.compile(r"https?://[^\s\"')<>]+", re.IGNORECASE)
SIZE_HEADER_VALUES = {"size", "sizes"}
QTY_HEADER_VALUES = {"qty", "quantity", "stock", "onhand", "qoh"}
PRODUCT_WORDS = {
    "beanie",
    "cap",
    "crewneck",
    "hoodie",
    "jacket",
    "pants",
    "shirt",
    "short",
    "shorts",
    "sweater",
    "sweatpants",
    "sweatshirt",
    "tee",
    "zip",
}
COLOR_WORDS = {
    "black",
    "blue",
    "brown",
    "camo",
    "cream",
    "green",
    "grey",
    "gray",
    "monochrome",
    "navy",
    "orange",
    "pink",
    "purple",
    "red",
    "royal",
    "vintage",
    "white",
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
    return max(0, int(match.group(0)))


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


def extract_url(value: Any) -> str | None:
    """Extract a direct URL from a plain URL, IMAGE formula, or hyperlink cell."""
    raw = str(value or "").strip()
    if not raw:
        return None
    match = URL_RE.search(raw)
    if not match:
        return None
    return match.group(0).rstrip(".,;")


def google_sheet_csv_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.netloc not in {"docs.google.com", "www.docs.google.com"}:
        return url
    match = re.search(r"/spreadsheets/d/([^/]+)", parsed.path)
    if not match:
        return url
    qs = parse_qs(parsed.query)
    fragment_qs = parse_qs(parsed.fragment)
    gid = (qs.get("gid") or fragment_qs.get("gid") or ["0"])[0]
    query = urlencode({"format": "csv", "gid": gid})
    return f"https://docs.google.com/spreadsheets/d/{match.group(1)}/export?{query}"


def detect_format(filename: str | None, content_type: str | None, content: bytes) -> str:
    name = (filename or "").lower()
    ctype = (content_type or "").lower()
    if name.endswith(".xlsx") or "spreadsheetml" in ctype or content.startswith(b"PK"):
        return "xlsx"
    return "csv"


def _reject_html_download(content: bytes, content_type: str | None = None) -> None:
    ctype = (content_type or "").lower()
    prefix = content[:512].lstrip().lower()
    if "text/html" in ctype or prefix.startswith(b"<!doctype html") or prefix.startswith(b"<html"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "The link downloaded a web page instead of spreadsheet data. "
                "Make the sheet shared as anyone-with-link read-only, or use a direct CSV/XLSX export link."
            ),
        )


def _header_score(values: list[Any]) -> int:
    fields = [resolve_field(str(value)) for value in values if str(value or "").strip()]
    unique_fields = {field for field in fields if field}
    if not unique_fields:
        return 0
    score = len(unique_fields)
    if "name" in unique_fields:
        score += 3
    if {"sku", "upc", "brand", "category"} & unique_fields:
        score += 2
    if {"buy_price", "expected_sell_price", "quantity"} & unique_fields:
        score += 2
    return score


def _unique_headers(values: list[Any]) -> list[str]:
    headers: list[str] = []
    seen: dict[str, int] = {}
    for idx, value in enumerate(values, start=1):
        header = str(value or "").strip() or f"Column {idx}"
        count = seen.get(header, 0)
        seen[header] = count + 1
        headers.append(header if count == 0 else f"{header} {count + 1}")
    return headers


def _compact_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _non_empty(row: list[Any], col: int) -> str:
    if col < 0 or col >= len(row):
        return ""
    return _compact_text(row[col])


def _is_matrix_size_label(value: Any) -> bool:
    label = _compact_text(value).upper()
    if not label:
        return False
    if label in {"XS", "S", "M", "L", "XL", "XXL", "XXXL", "OS", "O/S", "ONE SIZE"}:
        return True
    return bool(re.fullmatch(r"\d{1,2}(\.\d)?", label))


def _size_quantity_pairs(row: list[Any]) -> list[tuple[int, int]]:
    pairs: list[tuple[int, int]] = []
    for idx, value in enumerate(row):
        if normalize_header(value) not in SIZE_HEADER_VALUES:
            continue
        for qty_col in range(idx + 1, min(idx + 4, len(row))):
            if normalize_header(row[qty_col]) in QTY_HEADER_VALUES:
                pairs.append((idx, qty_col))
                break
    return pairs


def _matrix_quantity(value: Any) -> int:
    raw = str(value or "").strip()
    if not raw:
        return 0
    match = re.search(r"\d+", raw)
    if not match:
        return 0
    return max(0, int(match.group(0)))


def _find_matrix_product_name(
    table_rows: list[list[Any]],
    header_idx: int,
    pairs: list[tuple[int, int]],
    pair_idx: int,
) -> tuple[str, int] | tuple[None, None]:
    size_col, qty_col = pairs[pair_idx]
    left_bound = pairs[pair_idx - 1][1] + 1 if pair_idx > 0 else 0
    right_bound = pairs[pair_idx + 1][0] - 1 if pair_idx + 1 < len(pairs) else qty_col + 2
    right_bound = max(left_bound, min(right_bound, max((len(row) for row in table_rows), default=0) - 1))

    preferred_cols = [size_col - 1, size_col, qty_col - 1, qty_col]
    preferred_cols.extend(range(left_bound, right_bound + 1))
    ordered_cols = list(dict.fromkeys(col for col in preferred_cols if left_bound <= col <= right_bound))

    for row_idx in range(header_idx - 1, max(-1, header_idx - 8), -1):
        row = table_rows[row_idx]
        for col in ordered_cols:
            candidate = _non_empty(row, col)
            normalized = normalize_header(candidate)
            if not candidate or normalized in SIZE_HEADER_VALUES | QTY_HEADER_VALUES:
                continue
            if _is_matrix_size_label(candidate) or candidate.isdigit():
                continue
            return candidate, row_idx + 1
    return None, None


def _collect_matrix_variants(
    table_rows: list[list[Any]],
    header_idx: int,
    pairs: list[tuple[int, int]],
) -> dict[int, list[dict[str, int | str]]]:
    variants_by_pair: dict[int, list[dict[str, int | str]]] = {idx: [] for idx in range(len(pairs))}
    relevant_cols = {col for pair in pairs for col in pair}

    for row in table_rows[header_idx + 1:]:
        if _size_quantity_pairs(row):
            break
        if not any(_non_empty(row, col) for col in relevant_cols):
            break

        for pair_idx, (size_col, qty_col) in enumerate(pairs):
            size = _non_empty(row, size_col)
            if not size or normalize_header(size) in SIZE_HEADER_VALUES:
                continue
            if not _is_matrix_size_label(size):
                continue
            variants_by_pair[pair_idx].append({
                "size": size,
                "quantity": _matrix_quantity(_non_empty(row, qty_col)),
            })

    return variants_by_pair


def _infer_category(name: str) -> str | None:
    normalized = normalize_header(name)
    if "sweatshort" in normalized or "short" in normalized:
        return "Shorts"
    if "sweatpant" in normalized:
        return "Sweatpants"
    if "hoodie" in normalized or "zipup" in normalized:
        return "Hoodie"
    if "beanie" in normalized or "cap" in normalized:
        return "Headwear"
    if "shirt" in normalized or normalized.endswith("tee"):
        return "Shirt"
    return None


def _infer_color(raw_name: str) -> str | None:
    lines = [line.strip() for line in str(raw_name or "").splitlines() if line.strip()]
    if not lines:
        return None

    tail_words = re.findall(r"[A-Za-z]+", lines[-1].lower())
    if not tail_words:
        return None

    if not any(word in COLOR_WORDS for word in tail_words):
        return None

    if not any(word in PRODUCT_WORDS for word in tail_words):
        return lines[-1][:50]

    color_tail: list[str] = []
    for word in reversed(tail_words):
        if word not in COLOR_WORDS:
            break
        color_tail.append(word)
    if not color_tail:
        return None
    return " ".join(reversed(color_tail)).title()[:50]


def _warehouse_matrix_rows_to_dicts(table_rows: list[list[Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    for header_idx, row in enumerate(table_rows):
        pairs = _size_quantity_pairs(row)
        if not pairs:
            continue

        variants_by_pair = _collect_matrix_variants(table_rows, header_idx, pairs)
        for pair_idx, variants in variants_by_pair.items():
            if not variants:
                continue
            product_name, product_row_number = _find_matrix_product_name(table_rows, header_idx, pairs, pair_idx)
            if not product_name or product_row_number is None:
                continue

            name = _compact_text(product_name)
            total_quantity = sum(int(variant["quantity"]) for variant in variants)
            parsed_row: dict[str, Any] = {
                "Product Name": name,
                "Qty": str(total_quantity),
                "__variants": variants,
                "__layout": "size_quantity_matrix",
                "__row_number": product_row_number,
            }
            category = _infer_category(name)
            if category:
                parsed_row["Category"] = category
            color = _infer_color(str(product_name))
            if color:
                parsed_row["Color"] = color
            rows.append(parsed_row)

    return rows


def _table_rows_to_dicts(table_rows: list[list[Any]]) -> list[dict[str, Any]]:
    matrix_rows = _warehouse_matrix_rows_to_dicts(table_rows)
    if matrix_rows:
        return matrix_rows

    candidates = [
        (idx, _header_score(row))
        for idx, row in enumerate(table_rows[:25])
        if any(str(value or "").strip() for value in row)
    ]
    if not candidates:
        return []

    header_idx, score = max(candidates, key=lambda item: item[1])
    if score < 3:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Could not find an inventory header row. Add headers like Product Name, SKU, "
                "Brand, Cost, List Price, Qty, or Image URL."
            ),
        )

    headers = _unique_headers(table_rows[header_idx])
    rows: list[dict[str, Any]] = []
    for row in table_rows[header_idx + 1:]:
        if not any(value not in (None, "") for value in row):
            continue
        rows.append({
            headers[idx]: value
            for idx, value in enumerate(row)
            if idx < len(headers) and value not in (None, "")
        })
    return rows


def rows_from_bytes(content: bytes, file_format: str, content_type: str | None = None) -> list[dict[str, Any]]:
    if len(content) > MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Spreadsheet is too large. Import files must be 8 MB or less.",
        )
    _reject_html_download(content, content_type)

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
        return _table_rows_to_dicts([list(row) for row in sheet.iter_rows(values_only=True)])

    text = content.decode("utf-8-sig", errors="replace")
    sample = text[:2048]
    try:
        dialect = csv.Sniffer().sniff(sample) if sample.strip() else csv.excel
    except csv.Error:
        dialect = csv.excel
    return _table_rows_to_dicts([list(row) for row in csv.reader(io.StringIO(text), dialect=dialect)])


def parse_inventory_rows(rows: list[dict[str, Any]]) -> list[ParsedImportRow]:
    parsed_rows: list[ParsedImportRow] = []

    for idx, raw in enumerate(rows, start=2):
        row_number = idx
        raw_row_number = raw.get("__row_number")
        if isinstance(raw_row_number, int):
            row_number = raw_row_number
        mapped: dict[str, Any] = {}
        custom_attributes: dict[str, Any] = {}
        warnings: list[str] = []

        for header, value in raw.items():
            if header == "__row_number":
                continue
            if value is None or str(value).strip() == "":
                continue
            if str(header).startswith("__"):
                attribute_name = {
                    "__variants": "variants",
                    "__layout": "import_layout",
                }.get(str(header))
                if attribute_name:
                    custom_attributes[attribute_name] = value
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
            parsed_rows.append(ParsedImportRow(row_number, {}, "", raw, warnings))
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
        photo_front_url = extract_url(mapped.get("photo_front_url"))
        if photo_front_url:
            payload["photo_front_url"] = photo_front_url
        elif mapped.get("photo_front_url"):
            warnings.append("Ignored photo column because it was not a direct http(s) URL.")
        photo_back_url = extract_url(mapped.get("photo_back_url"))
        if photo_back_url:
            payload["photo_back_url"] = photo_back_url

        custom_attributes["import_raw"] = {
            str(k): v for k, v in raw.items() if not str(k).startswith("__") and v not in (None, "")
        }
        payload["custom_attributes"] = custom_attributes
        payload = {k: v for k, v in payload.items() if v not in (None, "")}

        fingerprint_base = "|".join(
            str(payload.get(field, "")) for field in ("sku", "upc", "name", "size", "color")
        )
        external_id = hashlib.sha256(fingerprint_base.encode("utf-8")).hexdigest()[:32]
        parsed_rows.append(ParsedImportRow(row_number, payload, external_id, raw, warnings))

    return parsed_rows
