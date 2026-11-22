"""Import sales from a marketplace's sales-report CSV (Poshmark, Mercari,
Whatnot, Depop, or any similar export).

Columns are matched by name, so exports with slightly different headers
still work: a sale needs a price; date, title, order ID, fees, net and
quantity are read when present. Fees are the sum of every fee/commission
column, else price minus net. Each sale is keyed by (platform, order ID) —
or a hash of date/title/price when the export has no ID — so importing the
same file twice adds nothing.
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from sqlalchemy.orm import Session

from app.models.transaction import Transaction

PLATFORMS = {"poshmark": "Poshmark", "mercari": "Mercari", "whatnot": "Whatnot", "depop": "Depop", "other_csv": "Other"}
MAX_ROWS = 5000

_SYNONYMS = {
    "date": ["orderdate", "solddate", "dateofsale", "saledate", "datesold", "placedat", "orderplaced", "date", "created"],
    "title": ["listingtitle", "itemtitle", "itemname", "productname", "itemdescription", "title", "item", "description", "name", "product"],
    "order_id": ["orderid", "ordernumber", "transactionid", "salesid", "itemid", "listingid", "id"],
    "gross": ["orderprice", "itemprice", "soldprice", "saleprice", "price", "totalprice", "subtotal", "itemtotal", "salesprice"],
    "net": ["netearnings", "netsellerproceeds", "totalearnings", "netproceeds", "earnings", "payout", "net", "youearned", "total"],
    "quantity": ["quantity", "qty"],
}
_DATE_FORMATS = ["%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y", "%m/%d/%y",
                 "%m/%d/%Y %H:%M", "%m/%d/%Y %I:%M %p", "%b %d, %Y", "%B %d, %Y", "%d %b %Y"]


def _norm(header: str) -> str:
    return re.sub(r"[^a-z0-9]", "", header.lower())


def detect_columns(headers: list[str]) -> tuple[dict[str, str], list[str]]:
    """Map canonical fields to CSV headers; also return the fee columns."""
    normed = {h: _norm(h) for h in headers}
    mapping: dict[str, str] = {}
    fee_cols = [h for h, n in normed.items() if ("fee" in n or "commission" in n) and "shipping" not in n]
    for field, names in _SYNONYMS.items():
        for name in names:  # earlier synonyms win
            match = next((h for h, n in normed.items() if n == name and h not in fee_cols
                          and h not in mapping.values()), None)
            if match:
                mapping[field] = match
                break
    return mapping, fee_cols


def _money(raw: str | None) -> Decimal | None:
    if raw is None:
        return None
    text = raw.strip().replace("$", "").replace(",", "")
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    try:
        value = Decimal(text.strip("()"))
    except InvalidOperation:
        return None
    return -value if negative else value


def _date(raw: str | None) -> datetime | None:
    text = (raw or "").strip()
    if not text:
        return None
    candidates = [text, text.replace("Z", "+00:00")]
    for c in candidates:
        try:
            dt = datetime.fromisoformat(c)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def parse_sales_csv(content: bytes) -> tuple[list[dict], list[dict], dict[str, str]]:
    """Return (sales, errors, mapping). Each sale has date, title, order_id, gross, fee, quantity."""
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    headers = [h for h in (reader.fieldnames or []) if h]
    mapping, fee_cols = detect_columns(headers)
    if "gross" not in mapping:
        return [], [{"row": 1, "reason": "Couldn't find a sale price column (e.g. 'Order Price', 'Item Price', 'Sold Price')."}], mapping
    sales: list[dict] = []
    errors: list[dict] = []
    for index, row in enumerate(reader, start=2):
        if index - 1 > MAX_ROWS:
            errors.append({"row": index, "reason": f"Only the first {MAX_ROWS} rows are imported."})
            break
        if not any((v or "").strip() for v in row.values()):
            continue
        gross = _money(row.get(mapping["gross"]))
        if gross is None or gross <= 0:
            errors.append({"row": index, "reason": "No sale price."})
            continue
        fees = [f for f in (_money(row.get(c)) for c in fee_cols) if f is not None]
        net = _money(row.get(mapping["net"])) if "net" in mapping else None
        if fees:
            fee = sum((abs(f) for f in fees), Decimal("0"))
        elif net is not None and Decimal("0") <= net <= gross:
            fee = gross - net
        else:
            fee = Decimal("0")
        fee = min(fee, gross)
        qty_raw = (row.get(mapping["quantity"]) or "").strip() if "quantity" in mapping else ""
        sales.append({
            "row": index,
            "date": _date(row.get(mapping["date"])) if "date" in mapping else None,
            "title": ((row.get(mapping["title"]) or "").strip() if "title" in mapping else "")[:200],
            "order_id": ((row.get(mapping["order_id"]) or "").strip() if "order_id" in mapping else "")[:200],
            "gross": gross.quantize(Decimal("0.01")),
            "fee": fee.quantize(Decimal("0.01")),
            "quantity": int(qty_raw) if qty_raw.isdigit() and int(qty_raw) > 0 else 1,
        })
    return sales, errors, mapping


def _external_id(platform: str, sale: dict) -> str:
    if sale["order_id"]:
        return sale["order_id"]
    basis = f"{platform}|{sale['date'].isoformat() if sale['date'] else ''}|{sale['title']}|{sale['gross']}"
    return "row:" + hashlib.sha256(basis.encode()).hexdigest()[:24]


def import_sales(db: Session, user_id: uuid.UUID, platform: str, content: bytes, dry_run: bool) -> dict:
    sales, errors, mapping = parse_sales_csv(content)
    existing = {
        ref for (ref,) in db.query(Transaction.external_reference_id)
        .filter(Transaction.user_id == user_id, Transaction.source == platform,
                Transaction.external_reference_id.isnot(None))
        .all()
    }
    new, duplicates, seen = [], 0, set()
    for sale in sales:
        ref = _external_id(platform, sale)
        if ref in existing or ref in seen:
            duplicates += 1
            continue
        seen.add(ref)
        new.append((ref, sale))
    if not dry_run:
        for ref, sale in new:
            note = f"{PLATFORMS[platform]} sale" + (f": {sale['title']}" if sale["title"] else "")
            txn = Transaction(
                user_id=user_id, method="other", status="completed", source=platform,
                external_reference_id=ref, gross_amount=sale["gross"], fee_amount=sale["fee"],
                net_amount=sale["gross"] - sale["fee"], quantity=sale["quantity"], notes=note[:500],
            )
            if sale["date"]:
                txn.created_at = sale["date"]
            db.add(txn)
        db.commit()
    return {
        "platform": platform,
        "dry_run": dry_run,
        "columns": mapping,
        "rows": len(sales) + len([e for e in errors if e["reason"] == "No sale price."]),
        "new_sales": len(new),
        "duplicates": duplicates,
        "imported": 0 if dry_run else len(new),
        "gross_total": str(sum((s["gross"] for _, s in new), Decimal("0.00"))),
        "fee_total": str(sum((s["fee"] for _, s in new), Decimal("0.00"))),
        "missing_dates": sum(1 for _, s in new if not s["date"]),
        "errors": errors[:50],
    }
