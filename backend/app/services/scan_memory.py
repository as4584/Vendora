"""Teach Smart Scan from inventory the seller already has (imports, backfill).

Memory rows written by the seller's own saves (POST /scan/learn) are what they
confirmed for a barcode, and are always newer than a spreadsheet or an old
item. So these bulk paths only *create* missing rows, or fill in fields an
existing row doesn't have yet; they never overwrite a confirmed value and
don't count as a "seen" scan.
"""
from typing import Iterable

from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem
from app.models.scan_memory import ScanMemory
from app.routers.scan import _item_fields, normalize_barcode, normalize_style


def remember_items(db: Session, user_id, items: Iterable[InventoryItem]) -> dict:
    """Upsert scan memory for items that have a barcode and a name.

    Returns {"created": n, "updated": n, "skipped": n}. Does not commit.
    """
    by_code: dict[str, dict] = {}
    skipped = 0
    for item in items:
        code = normalize_barcode(item.upc or "") if item.upc else ""
        fields = _item_fields(item)
        if len(code) < 4 or not fields.get("name"):
            skipped += 1
            continue
        style = normalize_style(fields.get("style_code"))
        if style:
            fields["style_code"] = style
        # Later rows of the same barcode only fill gaps, like existing memory.
        by_code[code] = {**fields, **by_code.get(code, {})}

    counts = {"created": 0, "updated": 0, "skipped": skipped}
    if not by_code:
        return counts
    existing = {
        row.barcode: row
        for row in db.query(ScanMemory)
        .filter(ScanMemory.user_id == user_id, ScanMemory.barcode.in_(list(by_code)))
        .all()
    }
    for code, fields in by_code.items():
        mem = existing.get(code)
        if mem is None:
            db.add(ScanMemory(
                user_id=user_id, barcode=code, style_code=fields.get("style_code"),
                fields=fields, times_seen=1,
            ))
            counts["created"] += 1
            continue
        current = dict(mem.fields or {})
        missing = {k: v for k, v in fields.items() if k not in current}
        if not missing:
            counts["skipped"] += 1
            continue
        mem.fields = {**current, **missing}
        if not mem.style_code and missing.get("style_code"):
            mem.style_code = missing["style_code"]
        counts["updated"] += 1
    db.flush()
    return counts
