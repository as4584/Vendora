"""Spreadsheet inventory import helpers.

Accepts messy reseller spreadsheets and maps common column names into the
Resqlo inventory model. The router owns authentication and persistence.
"""
from __future__ import annotations

import csv
import base64
import hashlib
import io
from itertools import takewhile
import posixpath
import re
import zipfile
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any
from xml.etree import ElementTree
from urllib.parse import parse_qs, urlencode, urlparse

from fastapi import HTTPException, status

import logging

logger = logging.getLogger(__name__)


MAX_CSV_IMPORT_BYTES = 500 * 1024 * 1024
MAX_XLSX_IMPORT_BYTES = 500 * 1024 * 1024
MAX_EMBEDDED_IMAGE_BYTES = 40 * 1024 * 1024
# Zip-bomb guard for XLSX (a zip archive): total inflated size, member count,
# and per-member compression ratio (legit XML compresses ~10-20x).
MAX_XLSX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
MAX_XLSX_MEMBERS = 50000
MAX_XLSX_COMPRESSION_RATIO = 1000
# Pictures inside an .xlsx; the text-only reader never opens them.
MEDIA_PREFIXES = ("xl/media/", "xl/embeddings/", "xl/drawings/")
MAX_EMBEDDED_IMAGE_DIMENSION = 640
JPEG_THUMBNAIL_QUALITY = 76

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
HORIZONTAL_SIZE_HEADERS = {
    "xxs",
    "xs",
    "s",
    "sm",
    "small",
    "m",
    "md",
    "medium",
    "l",
    "lg",
    "large",
    "xl",
    "xxl",
    "2xl",
    "xxxl",
    "3xl",
    "4xl",
    "os",
    "onesize",
}
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
    item_id: str | None = None


@dataclass(frozen=True)
class EmbeddedImage:
    row: int
    col: int
    data_url: str


def normalize_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def resolve_field(header: str) -> str | None:
    normalized = normalize_header(header)
    for field, aliases in FIELD_ALIASES.items():
        if normalized in {normalize_header(alias) for alias in aliases}:
            return field
    return None


_CURRENCY_JUNK = re.compile(r"[^\d.,\-()]")
_THOUSANDS_COMMA = re.compile(r"^\d{1,3}(,\d{3})+(\.\d+)?$")
_THOUSANDS_DOT = re.compile(r"^\d{1,3}(\.\d{3}){2,}(,\d+)?$|^\d{1,3}\.\d{3},\d+$")


def parse_money(value: Any) -> tuple[str | None, str | None]:
    """Parse a price cell. Returns (amount "0.00" or None, warning or None).

    Handles "$1,200.00", "1.234,56 EUR", "12,5", "USD 40". Negative amounts
    ("-5", "(5.00)") and non-numbers ("free", "TBD") are rejected with a
    warning rather than silently changed.
    """
    raw = str(value or "").strip()
    if not raw:
        return None, None
    compact = _CURRENCY_JUNK.sub("", raw)
    if not re.search(r"\d", compact):
        return None, f'Could not read price "{raw}"; left blank.'
    if compact.startswith("-") or (compact.startswith("(") and compact.endswith(")")):
        return None, f'Negative price "{raw}" ignored.'
    number = compact.strip("()")
    if "," in number and "." in number:
        if number.rfind(",") > number.rfind("."):
            number = number.replace(".", "").replace(",", ".")  # 1.234,56
        else:
            number = number.replace(",", "")  # 1,234.56
    elif "," in number:
        number = number.replace(",", "") if _THOUSANDS_COMMA.match(number) else number.replace(",", ".")
    elif _THOUSANDS_DOT.match(number):
        number = number.replace(".", "")  # 1.234.567
    try:
        amount = Decimal(number)
    except InvalidOperation:
        return None, f'Could not read price "{raw}"; left blank.'
    return f"{amount.quantize(Decimal('0.01'))}", None


def decimal_string(value: Any) -> str | None:
    return parse_money(value)[0]


def parse_quantity(value: Any) -> tuple[int, str | None]:
    """Parse a quantity cell. Returns (quantity, warning or None)."""
    raw = str(value or "").strip()
    if not raw:
        return 1, "Quantity missing; set to 1."
    compact = raw.replace(",", "").replace(" ", "")
    match = re.fullmatch(r"(-?\d+)(?:\.(\d+))?(?:[a-zA-Z]+)?", compact)
    if not match:
        found = re.search(r"\d+", raw)
        if not found:
            return 1, f'Could not read quantity "{raw}"; set to 1.'
        return int(found.group(0)), f'Read quantity "{raw}" as {int(found.group(0))}.'
    whole = int(match.group(1))
    if whole < 0:
        return 0, f'Negative quantity "{raw}" set to 0.'
    if match.group(2) and int(match.group(2)) != 0:
        return whole, f'Quantity "{raw}" is not a whole number; used {whole}.'
    return whole, None


def int_value(value: Any) -> int:
    return parse_quantity(value)[0]


def parse_status(value: Any) -> tuple[str, str | None]:
    raw = str(value or "").strip().lower()
    if not raw:
        return "in_stock", None
    if raw in VALID_STATUSES:
        return raw, None
    normalized = re.sub(r"[_\-]+", " ", raw)
    known = STATUS_ALIASES.get(normalized) or STATUS_ALIASES.get(normalize_header(raw))
    if known:
        return known, None
    return "in_stock", f'Unknown status "{str(value).strip()}"; set to in stock.'


def status_value(value: Any) -> str:
    return parse_status(value)[0]


def unescape_cell(value: Any) -> Any:
    """Undo the export's formula-injection guard ('=x -> =x)."""
    if isinstance(value, str) and len(value) > 1 and value[0] == "'" and value[1] in "=+-@\t\r":
        return value[1:]
    return value


_SIZE_BREAKDOWN_PART = re.compile(r"^\s*(.+?)\s*\((\d+)\)\s*$")


def parse_size_breakdown(value: Any) -> list[dict[str, Any]]:
    """Parse the export's "S (1); M (3)" back into variant rows."""
    variants: list[dict[str, Any]] = []
    for part in str(value or "").split(";"):
        match = _SIZE_BREAKDOWN_PART.match(part)
        if match:
            variants.append({"size": match.group(1), "quantity": int(match.group(2))})
    return variants


# Columns Resqlo writes on export that are bookkeeping, not item data.
EXPORT_ONLY_HEADERS = {"id", "externalid", "createdat", "updatedat", "sizebreakdown", "backimageformula"}
# The export's own `source` column ("spreadsheet"/"manual"/...) is not a vendor.
VENDORA_SOURCE_VALUES = {"spreadsheet", "manual", "lightspeed", "square", "clover", "ebay", "shopify"}


def looks_like_url(value: Any) -> bool:
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def extract_url(value: Any) -> str | None:
    """Extract a direct URL from a plain URL, IMAGE formula, or hyperlink cell."""
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw.startswith("data:image/"):
        return raw
    match = URL_RE.search(raw)
    if not match:
        return None
    return match.group(0).rstrip(".,;")


def google_sheet_csv_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.netloc not in {"docs.google.com", "www.docs.google.com"}:
        return url
    published_match = re.search(r"/spreadsheets/(?:u/\d+/)?d/e/([^/]+)", parsed.path)
    match = re.search(r"/spreadsheets/(?:u/\d+/)?d/([^/]+)", parsed.path)
    qs = parse_qs(parsed.query)
    fragment_qs = parse_qs(parsed.fragment)
    gid = (qs.get("gid") or fragment_qs.get("gid") or ["0"])[0]
    if published_match:
        query = urlencode({"single": "true", "output": "csv", "gid": gid})
        return f"https://docs.google.com/spreadsheets/d/e/{published_match.group(1)}/pub?{query}"
    if not match:
        return url
    query = urlencode({"format": "csv", "gid": gid})
    return f"https://docs.google.com/spreadsheets/d/{match.group(1)}/export?{query}"


def google_sheet_xlsx_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.netloc not in {"docs.google.com", "www.docs.google.com"}:
        return url
    match = re.search(r"/spreadsheets/(?:u/\d+/)?d/([^/]+)", parsed.path)
    if match and match.group(1) == "e":
        return url
    if not match:
        return url
    return f"https://docs.google.com/spreadsheets/d/{match.group(1)}/export?format=xlsx"


def google_sheet_export_urls(url: str) -> list[str]:
    parsed = urlparse(url)
    if parsed.netloc not in {"docs.google.com", "www.docs.google.com"}:
        return [url]
    if re.search(r"/spreadsheets/(?:u/\d+/)?d/e/([^/]+)", parsed.path):
        return [google_sheet_csv_url(url)]
    if re.search(r"/spreadsheets/(?:u/\d+/)?d/([^/]+)", parsed.path):
        return [google_sheet_xlsx_url(url), google_sheet_csv_url(url)]
    return [url]


def google_sheet_candidate_csv_urls(url: str, html: str, limit: int = 80) -> list[str]:
    parsed = urlparse(url)
    match = re.search(r"/spreadsheets/(?:u/\d+/)?d/([^/]+)", parsed.path)
    if parsed.netloc not in {"docs.google.com", "www.docs.google.com"} or not match:
        return []

    gids: list[str] = []
    for pattern in (
        r'gid=(\d+)',
        r'\[\\"(\d{1,10})\\",\d+,\d+,\d+,\d+\].{0,700}(?:ITEM NAME|INVENTORY|XXS|XS|SM|MENS|PANTS|TOTAL)',
        r'"sheetId":(\d+)',
    ):
        for found in re.findall(pattern, html):
            gid = found if isinstance(found, str) else found[0]
            if gid not in gids:
                gids.append(gid)
            if len(gids) >= limit:
                break
        if len(gids) >= limit:
            break

    sheet_id = match.group(1)
    return [
        f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?{urlencode({'format': 'csv', 'gid': gid})}"
        for gid in gids
    ]


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


STRONG_HEADER_SCORE = 7


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
    if label in {"XXS", "XS", "S", "SM", "M", "MD", "L", "LG", "XL", "XXL", "2XL", "XXXL", "3XL", "OS", "O/S", "ONE SIZE"}:
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
) -> tuple[str, int, int] | tuple[None, None, None]:
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
            return candidate, row_idx + 1, col + 1
    return None, None, None


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

    color_tail = list(takewhile(lambda word: word in COLOR_WORDS, reversed(tail_words)))
    if not color_tail:
        return None
    return " ".join(reversed(color_tail)).title()[:50]


def _display_size_label(value: Any) -> str:
    raw = _compact_text(value)
    normalized = normalize_header(raw)
    return {
        "sm": "S",
        "small": "S",
        "md": "M",
        "medium": "M",
        "lg": "L",
        "large": "L",
        "onesize": "OS",
    }.get(normalized, raw.upper())


GRID_NAME_HEADERS = {"itemname", "productname", "name", "product", "item", "model", "style"}


def _is_shoe_size_header(value: Any) -> bool:
    """A header cell that is a shoe size: 4 to 18, whole or half (8, 8.5, "10.5")."""
    if isinstance(value, bool):
        return False
    label = _compact_text(value)
    if not re.fullmatch(r"\d{1,2}(\.[05])?", label):
        return False
    return 1 <= float(label) <= 18


def _horizontal_size_table_rows_to_dicts(table_rows: list[list[Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    current_category: str | None = None

    for header_idx, row in enumerate(table_rows):
        normalized = [normalize_header(value) for value in row]
        name_cols = [idx for idx, value in enumerate(normalized) if value in GRID_NAME_HEADERS]
        if not name_cols:
            non_empty = [_compact_text(value) for value in row if _compact_text(value)]
            if "inventory" in normalized and non_empty:
                current_category = non_empty[0][:50]
            continue

        name_col = name_cols[0]
        size_cols = [
            (idx, _display_size_label(row[idx]))
            for idx, value in enumerate(normalized)
            if idx > name_col and (value in HORIZONTAL_SIZE_HEADERS or _is_shoe_size_header(row[idx]))
        ]
        # Numbers as headers could be anything; two or more shoe sizes make it a grid.
        numeric = sum(1 for idx, _ in size_cols if _is_shoe_size_header(row[idx]))
        if not size_cols or (numeric and len(size_cols) < 2):
            continue

        total_cols = [
            idx
            for idx, value in enumerate(normalized)
            if idx > name_col and value in {"instock", "total", "quantity", "qty"}
        ]

        for row_number, data_row in enumerate(table_rows[header_idx + 1:], start=header_idx + 2):
            if _horizontal_size_table_rows_to_dicts_should_stop(data_row, name_col):
                break

            name = _compact_text(data_row[name_col] if name_col < len(data_row) else "")
            if not name or normalize_header(name) in {"itemname", "productname", "totalitemsinstock"}:
                continue

            variants: list[dict[str, int | str]] = []
            for col, size in size_cols:
                quantity = _matrix_quantity(data_row[col] if col < len(data_row) else "")
                variants.append({"size": size, "quantity": quantity})

            total_quantity = sum(int(variant["quantity"]) for variant in variants)
            if total_quantity == 0:
                for total_col in total_cols:
                    total_quantity = max(total_quantity, _matrix_quantity(data_row[total_col] if total_col < len(data_row) else ""))
            if total_quantity <= 0:
                continue

            parsed_row: dict[str, Any] = {
                "Product Name": name,
                "Qty": str(total_quantity),
                "__variants": variants,
                "__layout": "horizontal_size_table",
                "__row_number": row_number,
            }
            if current_category:
                parsed_row["Category"] = current_category
            color = _infer_color(name)
            if color:
                parsed_row["Color"] = color
            rows.append(parsed_row)

    return rows


def _horizontal_size_table_rows_to_dicts_should_stop(row: list[Any], name_col: int) -> bool:
    normalized = [normalize_header(value) for value in row]
    if "inventory" in normalized and not {"itemname", "productname"} & set(normalized):
        return True
    value = normalize_header(row[name_col] if name_col < len(row) else "")
    return value in {"itemname", "productname"}


def _warehouse_matrix_rows_to_dicts(
    table_rows: list[list[Any]],
    embedded_images: list[EmbeddedImage],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    for header_idx, row in enumerate(table_rows):
        pairs = _size_quantity_pairs(row)
        if not pairs:
            continue

        variants_by_pair = _collect_matrix_variants(table_rows, header_idx, pairs)
        for pair_idx, variants in variants_by_pair.items():
            if not variants:
                continue
            product_name, product_row_number, product_col_number = _find_matrix_product_name(
                table_rows,
                header_idx,
                pairs,
                pair_idx,
            )
            if not product_name or product_row_number is None or product_col_number is None:
                continue

            name = _compact_text(product_name)
            total_quantity = sum(int(variant["quantity"]) for variant in variants)
            size_col, qty_col = pairs[pair_idx]
            left_bound = pairs[pair_idx - 1][1] + 1 if pair_idx > 0 else 0
            right_bound = pairs[pair_idx + 1][0] - 1 if pair_idx + 1 < len(pairs) else qty_col + 2
            right_bound = max(left_bound, min(right_bound, max((len(row) for row in table_rows), default=0) - 1))
            parsed_row: dict[str, Any] = {
                "Product Name": name,
                "Qty": str(total_quantity),
                "__variants": variants,
                "__layout": "size_quantity_matrix",
                "__row_number": product_row_number,
            }
            image_url = _closest_matrix_image(
                embedded_images,
                product_row=product_row_number,
                product_col=product_col_number,
                header_row=header_idx + 1,
                left_bound=left_bound,
                right_bound=right_bound,
            )
            if image_url:
                parsed_row["Image URL"] = image_url
            category = _infer_category(name)
            if category:
                parsed_row["Category"] = category
            color = _infer_color(str(product_name))
            if color:
                parsed_row["Color"] = color
            rows.append(parsed_row)

    return rows


def assert_safe_xlsx_archive(content: bytes | str, skip_media: bool = False) -> None:
    """Refuse zip bombs before openpyxl or our own reader inflates anything.

    The declared uncompressed sizes in the central directory are checked; a
    member that lies about its size is still capped because zipfile verifies
    the size/CRC while reading. With ``skip_media`` (photos are never read),
    pictures don't count toward the limits, so a sheet with thousands of
    photos is fine.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(content) if isinstance(content, bytes) else content)
    except zipfile.BadZipFile:
        return  # not a zip at all: nothing to inflate; the parser reports it

    infos = archive.infolist()
    if skip_media:
        infos = [info for info in infos if not info.filename.startswith(MEDIA_PREFIXES)]
    total = sum(info.file_size for info in infos)
    if len(infos) > MAX_XLSX_MEMBERS or total > MAX_XLSX_UNCOMPRESSED_BYTES or any(
        info.file_size > 0 and info.compress_size > 0
        and info.file_size / info.compress_size > MAX_XLSX_COMPRESSION_RATIO
        and info.file_size > 1024 * 1024
        for info in infos
    ):
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Spreadsheet expands to more data than Resqlo can import.",
        )


def _image_data_url(image_bytes: bytes, path: str) -> str | None:
    if len(image_bytes) > MAX_EMBEDDED_IMAGE_BYTES:
        return None

    try:
        from PIL import Image
    except ImportError:
        Image = None

    if Image is not None:
        try:
            with Image.open(io.BytesIO(image_bytes)) as image:
                # Decode a big JPEG straight at reduced size: much less memory and time.
                image.draft("RGB", (MAX_EMBEDDED_IMAGE_DIMENSION, MAX_EMBEDDED_IMAGE_DIMENSION))
                image.thumbnail(
                    (MAX_EMBEDDED_IMAGE_DIMENSION, MAX_EMBEDDED_IMAGE_DIMENSION),
                    Image.Resampling.LANCZOS,
                )
                if image.mode not in {"RGB", "L"}:
                    image = image.convert("RGB")
                output = io.BytesIO()
                image.save(output, format="JPEG", quality=JPEG_THUMBNAIL_QUALITY)
                encoded = base64.b64encode(output.getvalue()).decode("ascii")
                return f"data:image/jpeg;base64,{encoded}"
        except Exception:
            logger.warning("Import: thumbnail conversion failed, using original image", exc_info=True)

    extension = path.rsplit(".", 1)[-1].lower()
    mime = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
    }.get(extension)
    if not mime:
        return None
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _resolve_xlsx_relationship_path(base_path: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(base_path), target))


XLSX_NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "rv": "http://schemas.microsoft.com/office/spreadsheetml/2017/richdata",
    "xlrd": "http://schemas.microsoft.com/office/spreadsheetml/2017/richdata",
}
_CELL_REF = re.compile(r"^([A-Z]+)(\d+)$")


def _col_number(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def _rels(archive: zipfile.ZipFile, rels_path: str) -> dict[str, str]:
    try:
        root = ElementTree.fromstring(archive.read(rels_path))
    except KeyError:
        return {}
    return {r.attrib.get("Id"): r.attrib.get("Target") for r in root.findall("rel:Relationship", XLSX_NS)}


def _rels_path(part: str) -> str:
    return posixpath.join(posixpath.dirname(part), "_rels", f"{posixpath.basename(part)}.rels")


def _drawing_picture_anchors(archive: zipfile.ZipFile, sheet_path: str) -> list[tuple[int, int, str]]:
    """Pictures floating over the sheet: (row, col, media path) of each top-left corner."""
    out: list[tuple[int, int, str]] = []
    sheet_rels = _rels(archive, _rels_path(sheet_path))
    for target in sheet_rels.values():
        if not target or "drawings/" not in target or target.endswith(".vml"):
            continue
        drawing_path = _resolve_xlsx_relationship_path(sheet_path, target)
        try:
            drawing_root = ElementTree.fromstring(archive.read(drawing_path))
        except KeyError:
            continue
        media = _rels(archive, _rels_path(drawing_path))
        for anchor_name in ("oneCellAnchor", "twoCellAnchor"):
            for anchor in drawing_root.findall(f"xdr:{anchor_name}", XLSX_NS):
                marker = anchor.find("xdr:from", XLSX_NS)
                blip = anchor.find(".//a:blip", XLSX_NS)
                if marker is None or blip is None:
                    continue
                media_target = media.get(blip.attrib.get(f"{{{XLSX_NS['r']}}}embed"))
                if not media_target:
                    continue
                row = int(marker.findtext("xdr:row", default="0", namespaces=XLSX_NS)) + 1
                col = int(marker.findtext("xdr:col", default="0", namespaces=XLSX_NS)) + 1
                out.append((row, col, _resolve_xlsx_relationship_path(drawing_path, media_target)))
    return out


def _in_cell_picture_anchors(archive: zipfile.ZipFile, sheet_path: str) -> list[tuple[int, int, str]]:
    """Excel 365 "Place in Cell" pictures: cell vm -> metadata -> rich value -> media."""
    names = set(archive.namelist())
    if "xl/metadata.xml" not in names or "xl/richData/rdrichvalue.xml" not in names:
        return []
    try:
        meta = ElementTree.fromstring(archive.read("xl/metadata.xml"))
        future = [
            int(rvb.attrib.get("i", "-1"))
            for bk in meta.findall("main:futureMetadata/main:bk", XLSX_NS)
            for rvb in bk.iter(f"{{{XLSX_NS['xlrd']}}}rvb")
        ]
        value_meta = [
            int(bk.find("main:rc", XLSX_NS).attrib.get("v", "-1"))
            for bk in meta.findall("main:valueMetadata/main:bk", XLSX_NS)
        ]
        # Which position in a rich value holds the picture's relationship index.
        rel_pos: dict[int, int] = {}
        if "xl/richData/rdrichvaluestructure.xml" in names:
            structs = ElementTree.fromstring(archive.read("xl/richData/rdrichvaluestructure.xml"))
            for s_idx, struct in enumerate(structs.findall("rv:s", XLSX_NS)):
                for k_idx, key in enumerate(struct.findall("rv:k", XLSX_NS)):
                    if key.attrib.get("n") == "_rvRel:LocalImageIdentifier":
                        rel_pos[s_idx] = k_idx
        values: list[int | None] = []
        for rv in ElementTree.fromstring(archive.read("xl/richData/rdrichvalue.xml")).findall("rv:rv", XLSX_NS):
            parts = [v.text or "" for v in rv.findall("rv:v", XLSX_NS)]
            pos = rel_pos.get(int(rv.attrib.get("s", "0")), 0)
            values.append(int(parts[pos]) if pos < len(parts) and parts[pos].isdigit() else None)
        rel_ids = [
            rel.attrib.get(f"{{{XLSX_NS['r']}}}id")
            for rel in ElementTree.fromstring(archive.read("xl/richData/richValueRel.xml"))
            if rel.tag.endswith("rel")
        ]
        rel_targets = _rels(archive, "xl/richData/_rels/richValueRel.xml.rels")
    except (KeyError, ValueError, AttributeError, ElementTree.ParseError):
        return []

    out: list[tuple[int, int, str]] = []
    with archive.open(sheet_path) as sheet:
        for _, cell in ElementTree.iterparse(sheet):
            if not cell.tag.endswith("}c"):
                continue
            vm = cell.attrib.get("vm")
            ref = _CELL_REF.match(cell.attrib.get("r", ""))
            cell.clear()
            if not vm or not ref:
                continue
            try:
                rel_index = values[future[value_meta[int(vm) - 1]]]
                target = rel_targets.get(rel_ids[rel_index])
            except (IndexError, TypeError, ValueError):
                continue
            if target:
                media = _resolve_xlsx_relationship_path("xl/richData/richValueRel.xml", target)
                out.append((int(ref.group(2)), _col_number(ref.group(1)), media))
    return out


def _first_sheet_path(archive: zipfile.ZipFile) -> str:
    try:
        workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
        first = workbook.find("main:sheets/main:sheet", XLSX_NS)
        rid = first.attrib.get(f"{{{XLSX_NS['r']}}}id") if first is not None else None
        target = _rels(archive, "xl/_rels/workbook.xml.rels").get(rid)
        if target:
            return _resolve_xlsx_relationship_path("xl/workbook.xml", target)
    except (KeyError, ElementTree.ParseError):
        pass
    return "xl/worksheets/sheet1.xml"


def _xlsx_first_sheet_images(content: bytes | str, on_progress=None) -> list[EmbeddedImage]:
    """Every picture on the first sheet, shrunk to a thumbnail one at a time.

    ``content`` is the file's bytes or its path on disk. ``on_progress(done,
    total)`` is called as pictures are processed.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(content) if isinstance(content, bytes) else content)
    except zipfile.BadZipFile:
        return []
    with archive:
        sheet_path = _first_sheet_path(archive)
        if sheet_path not in archive.namelist():
            return []
        try:
            anchors = _drawing_picture_anchors(archive, sheet_path) + _in_cell_picture_anchors(archive, sheet_path)
        except ElementTree.ParseError:
            return []

        images: list[EmbeddedImage] = []
        cache: dict[str, str | None] = {}
        for done, (row, col, media_path) in enumerate(anchors, start=1):
            if media_path not in cache:
                try:
                    too_big = archive.getinfo(media_path).file_size > MAX_EMBEDDED_IMAGE_BYTES
                    cache[media_path] = None if too_big else _image_data_url(archive.read(media_path), media_path)
                except (KeyError, zipfile.BadZipFile, OSError):
                    cache[media_path] = None  # missing or damaged picture: skip it, keep the row
            if cache[media_path]:
                images.append(EmbeddedImage(row=row, col=col, data_url=cache[media_path]))
            if on_progress and (done % 25 == 0 or done == len(anchors)):
                on_progress(done, len(anchors))
        return images


def _attach_row_photos(rows: list[tuple[int, dict[str, Any]]], images: list[EmbeddedImage]) -> None:
    """Give each item row the pictures sitting on that row, left to right."""
    by_row: dict[int, list[EmbeddedImage]] = {}
    for image in images:
        by_row.setdefault(image.row, []).append(image)
    for sheet_row, row in rows:
        photos = sorted(by_row.get(sheet_row, []), key=lambda image: image.col)
        if not photos:
            continue
        # Excel shows an in-cell picture's cell value as #VALUE!; it isn't text.
        for key in [k for k, v in row.items() if v == "#VALUE!"]:
            del row[key]
        # A photo link already in the row wins for the front photo.
        has_link = any(
            looks_like_url(v) for k, v in row.items()
            if "photo" in str(k).lower() or "image" in str(k).lower()
        )
        keys = [k for k in ("Front Photo", "Back Photo") if k not in row]
        if has_link and "Front Photo" in keys:
            keys.remove("Front Photo")
        for key, image in zip(keys, photos):
            row[key] = image.data_url


def _closest_matrix_image(
    images: list[EmbeddedImage],
    *,
    product_row: int,
    product_col: int,
    header_row: int,
    left_bound: int,
    right_bound: int,
) -> str | None:
    candidates: list[tuple[int, EmbeddedImage]] = []
    for image in images:
        if not (product_row <= image.row <= header_row):
            continue
        if not (left_bound + 1 <= image.col <= right_bound + 1):
            continue
        score = abs(image.row - product_row) * 10 + abs(image.col - product_col)
        candidates.append((score, image))
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[0])[1].data_url


def _table_rows_to_dicts(
    table_rows: list[list[Any]],
    embedded_images: list[EmbeddedImage] | None = None,
) -> list[dict[str, Any]]:
    horizontal_rows = _horizontal_size_table_rows_to_dicts(table_rows)
    if horizontal_rows:
        return horizontal_rows

    candidates = [
        (idx, _header_score(row))
        for idx, row in enumerate(table_rows[:25])
        if any(str(value or "").strip() for value in row)
    ]
    best = max(candidates, key=lambda item: item[1]) if candidates else None
    # Name + SKU/qty/price headers: an ordinary sheet, even with title rows on top.
    if not best or best[1] < STRONG_HEADER_SCORE:
        matrix_rows = _warehouse_matrix_rows_to_dicts(table_rows, embedded_images or [])
        if matrix_rows:
            return matrix_rows
    if not candidates:
        return []

    header_idx, score = best
    # A short sheet ("Name" only, or "Item, Qty") is fine as long as a column is recognised.
    if score < 3 and not any(resolve_field(value) for value in table_rows[header_idx] if value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Could not find an inventory header row. Add headers like Product Name, SKU, "
                "Brand, Cost, List Price, Qty, or Image URL."
            ),
        )

    headers = _unique_headers(table_rows[header_idx])
    numbered: list[tuple[int, dict[str, Any]]] = []
    for sheet_row, row in enumerate(table_rows[header_idx + 1:], start=header_idx + 2):
        if not any(value not in (None, "") for value in row):
            continue
        numbered.append((sheet_row, {
            headers[idx]: value
            for idx, value in enumerate(row)
            if idx < len(headers) and value not in (None, "")
        }))
    if embedded_images:
        _attach_row_photos(numbered, embedded_images)
    return [row for _, row in numbered]


def rows_from_bytes(
    content: bytes, file_format: str, content_type: str | None = None, with_images: bool = True,
) -> list[dict[str, Any]]:
    max_bytes = MAX_XLSX_IMPORT_BYTES if file_format == "xlsx" else MAX_CSV_IMPORT_BYTES
    max_mb = max_bytes // (1024 * 1024)
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Spreadsheet is too large. Import files must be {max_mb} MB or less.",
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
        # Pictures are read one at a time, each with its own cap, so they don't count here.
        assert_safe_xlsx_archive(content, skip_media=True)

        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        last_error: HTTPException | None = None
        try:
            for sheet_idx, sheet in enumerate(workbook.worksheets):
                table_rows = [list(row) for row in sheet.iter_rows(values_only=True)]
                try:
                    embedded_images = _xlsx_first_sheet_images(content) if sheet_idx == 0 and with_images else []
                    return _table_rows_to_dicts(table_rows, embedded_images=embedded_images)
                except HTTPException as exc:
                    last_error = exc
                    continue
        finally:
            workbook.close()
        if last_error:
            raise last_error
        return []

    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        # Excel on Windows saves "CSV" as Windows-1252, not UTF-8.
        text = content.decode("cp1252", errors="replace")
    sample = text[:2048]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;	|") if sample.strip() else csv.excel
    except csv.Error:
        dialect = csv.excel
    if getattr(dialect, "delimiter", ",") in {"\r", "\n"}:
        dialect = csv.excel
    # newline="" lets the csv module handle \r\n, \n and old-Mac \r endings (and newlines inside quotes).
    return _table_rows_to_dicts([list(row) for row in csv.reader(io.StringIO(text, newline=""), dialect=dialect)])


def xlsx_rows_from_path(path: str, with_images: bool = True, on_progress=None) -> list[dict[str, Any]]:
    """Read an .xlsx straight from disk at any file size.

    Rows stream from the file (openpyxl read-only mode). Pictures are read
    one at a time and kept only as small thumbnails, so memory follows the
    number of items, not the file size.
    """
    with open(path, "rb") as handle:
        _reject_html_download(handle.read(512))
    assert_safe_xlsx_archive(path, skip_media=True)
    from openpyxl import load_workbook

    # A file handle (not the path): openpyxl rejects paths not ending in .xlsx.
    with open(path, "rb") as handle:
        workbook = load_workbook(handle, read_only=True, data_only=True)
        last_error: HTTPException | None = None
        try:
            for sheet_idx, sheet in enumerate(workbook.worksheets):
                table_rows = [list(row) for row in sheet.iter_rows(values_only=True)]
                try:
                    images = _xlsx_first_sheet_images(path, on_progress) if sheet_idx == 0 and with_images else []
                    return _table_rows_to_dicts(table_rows, embedded_images=images)
                except HTTPException as exc:
                    last_error = exc
        finally:
            workbook.close()
    if last_error:
        raise last_error
    return []


def parse_inventory_rows(rows: list[dict[str, Any]]) -> list[ParsedImportRow]:
    parsed_rows: list[ParsedImportRow] = []

    for idx, raw in enumerate(rows, start=2):
        row_number = idx
        raw_row_number = raw.get("__row_number")
        if isinstance(raw_row_number, int):
            row_number = raw_row_number
        mapped: dict[str, Any] = {}
        mapped_priority: dict[str, int] = {}
        custom_attributes: dict[str, Any] = {}
        warnings: list[str] = []
        item_id: str | None = None
        size_breakdown: list[dict[str, Any]] = []

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
            value = unescape_cell(value)
            normalized = normalize_header(header)
            if normalized in EXPORT_ONLY_HEADERS:
                if normalized == "id":
                    item_id = str(value).strip()
                elif normalized == "sizebreakdown":
                    size_breakdown = parse_size_breakdown(value)
                continue
            if normalized == "source" and str(value).strip().lower() in VENDORA_SOURCE_VALUES:
                continue
            field = resolve_field(header)
            if not field:
                custom_attributes[normalized or str(header)] = value
                continue
            # A column named exactly like the field ("vendor_name", "name")
            # beats an alias ("source", "description"); otherwise first wins.
            priority = 0 if normalized == normalize_header(field) else 1
            if field in mapped and mapped_priority[field] <= priority:
                continue
            mapped[field] = str(value).strip()
            mapped_priority[field] = priority

        if not mapped.get("name"):
            brand = mapped.get("brand")
            sku = mapped.get("sku") or mapped.get("upc")
            category = mapped.get("category")
            mapped["name"] = " ".join(part for part in [brand, category, sku] if part).strip()

        if not mapped.get("name"):
            warnings.append("Skipped row without item name or usable identifier.")
            parsed_rows.append(ParsedImportRow(row_number, {}, "", raw, warnings))
            continue

        if size_breakdown and not custom_attributes.get("variants") and len(size_breakdown) > 1:
            custom_attributes["variants"] = size_breakdown

        buy_price, w1 = parse_money(mapped.get("buy_price"))
        expected_price, w2 = parse_money(mapped.get("expected_sell_price"))
        actual_price, w3 = parse_money(mapped.get("actual_sell_price"))
        quantity, w4 = parse_quantity(mapped.get("quantity"))
        status_val, w5 = parse_status(mapped.get("status"))
        warnings.extend(w for w in (w1, w2, w3, w4, w5) if w)

        payload: dict[str, Any] = {
            "name": mapped["name"][:255],
            "category": mapped.get("category"),
            "sku": mapped.get("sku"),
            "upc": mapped.get("upc"),
            "size": mapped.get("size"),
            "color": mapped.get("color"),
            "condition": mapped.get("condition"),
            "serial_number": mapped.get("serial_number"),
            "buy_price": buy_price,
            "expected_sell_price": expected_price,
            "actual_sell_price": actual_price,
            "platform": mapped.get("platform"),
            "quantity": quantity,
            "vendor_name": mapped.get("vendor_name"),
            "notes": mapped.get("notes"),
            "status": status_val,
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

        if not payload.get("buy_price") and not payload.get("expected_sell_price") and not payload.get("actual_sell_price"):
            warnings.append("Price missing. Ask the user to add cost or list price before selling this item.")
            custom_attributes.setdefault("import_review", {})["missing_price"] = True
        if not payload.get("size") and not custom_attributes.get("variants"):
            warnings.append("Size missing. Ask the user to confirm the size or mark it one-size.")
            custom_attributes.setdefault("import_review", {})["missing_size"] = True
        if not payload.get("photo_front_url"):
            warnings.append("Photo missing. Ask the user if they want to add a product photo.")
            custom_attributes.setdefault("import_review", {})["missing_photo"] = True

        payload["custom_attributes"] = custom_attributes
        payload = {k: v for k, v in payload.items() if v not in (None, "")}

        fingerprint_base = "|".join(
            str(payload.get(field, "")) for field in ("sku", "upc", "name", "size", "color")
        )
        external_id = hashlib.sha256(fingerprint_base.encode("utf-8")).hexdigest()[:32]
        parsed_rows.append(ParsedImportRow(row_number, payload, external_id, raw, warnings, item_id))

    return parsed_rows
