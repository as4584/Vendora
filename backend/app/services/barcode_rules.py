"""Turn any scanned code into an inventory item, under the seller's control.

Order for one scan:
  1. Resqlo label QR (``resqlo:item:<id>``)
  2. each enabled rule that matches, in the seller's order, looked up as told
  3. the raw code itself, looked up every way (linked code, UPC, SKU)
Items with stock left win over sold-out ones for the same code.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Iterable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.barcode import BarcodeRule, ItemBarcode
from app.models.inventory import InventoryItem

LABEL_PREFIX = "RESQLO:ITEM:"


def clean_code(raw: str) -> str:
    """Trim scanner noise (whitespace, control chars) and fold case."""
    return "".join(ch for ch in raw.strip() if ch.isprintable() and not ch.isspace()).upper()[:64]


def rule_matches(rule: BarcodeRule, code: str) -> bool:
    if not rule.enabled:
        return False
    if rule.prefix and not code.startswith(rule.prefix.upper()):
        return False
    if rule.suffix and not code.endswith(rule.suffix.upper()):
        return False
    if rule.min_length and len(code) < rule.min_length:
        return False
    if rule.max_length and len(code) > rule.max_length:
        return False
    return bool(rule.prefix or rule.suffix or rule.min_length or rule.max_length)


def apply_rule(rule: BarcodeRule, code: str) -> str:
    out = code
    if rule.prefix and rule.strip_prefix:
        out = out[len(rule.prefix):]
    if rule.suffix and rule.strip_suffix and out.endswith(rule.suffix.upper()):
        out = out[: len(out) - len(rule.suffix)]
    if rule.slice_start:
        start = rule.slice_start - 1
        out = out[start: start + rule.slice_length] if rule.slice_length else out[start:]
    elif rule.slice_length:
        out = out[: rule.slice_length]
    return out


@dataclass
class Candidate:
    code: str
    field: str  # auto | sku | upc | linked
    rule: Optional[BarcodeRule] = None


def candidates(raw: str, rules: Iterable[BarcodeRule]) -> list[Candidate]:
    code = clean_code(raw)
    out: list[Candidate] = []
    for rule in rules:
        if rule_matches(rule, code):
            transformed = apply_rule(rule, code)
            if transformed:
                out.append(Candidate(transformed, rule.lookup_field, rule))
    out.append(Candidate(code, "auto"))
    return out


def upc_variants(code: str) -> set[str]:
    variants = {code}
    if code.isdigit():
        variants.add(f"0{code}")
        if code.startswith("0") and len(code) > 1:
            variants.add(code[1:])
    return variants


def _live(db: Session, user_id):
    return db.query(InventoryItem).filter(
        InventoryItem.user_id == user_id, InventoryItem.deleted_at.is_(None)
    )


def _best(query) -> Optional[InventoryItem]:
    # Prefer an item that can still be sold, then the newest.
    return query.order_by((InventoryItem.quantity > 0).desc(), InventoryItem.created_at.desc()).first()


def find_item(db: Session, user_id, code: str, field: str) -> tuple[Optional[InventoryItem], Optional[str]]:
    if field in ("auto", "linked"):
        link = db.query(ItemBarcode).filter_by(user_id=user_id, code=code).first()
        if link:
            item = _live(db, user_id).filter(InventoryItem.id == link.inventory_item_id).first()
            if item:
                return item, "linked"
    if field in ("auto", "upc"):
        item = _best(_live(db, user_id).filter(InventoryItem.upc.in_(sorted(upc_variants(code)))))
        if item:
            return item, "upc"
    if field in ("auto", "sku"):
        item = _best(_live(db, user_id).filter(func.upper(InventoryItem.sku) == code))
        if item:
            return item, "sku"
    return None, None


@dataclass
class Resolution:
    code: str
    item: Optional[InventoryItem]
    matched_by: Optional[str]  # label | linked | upc | sku | None
    rule_name: Optional[str]


def user_rules(db: Session, user_id) -> list[BarcodeRule]:
    return (
        db.query(BarcodeRule)
        .filter_by(user_id=user_id)
        .order_by(BarcodeRule.position, BarcodeRule.created_at)
        .all()
    )


def resolve(db: Session, user_id, raw: str) -> Resolution:
    code = clean_code(raw)
    if code.startswith(LABEL_PREFIX):
        try:
            item_id = uuid.UUID(code[len(LABEL_PREFIX):])
        except ValueError:
            item_id = None
        item = _live(db, user_id).filter(InventoryItem.id == item_id).first() if item_id else None
        return Resolution(code, item, "label" if item else None, None)

    for cand in candidates(code, user_rules(db, user_id)):
        item, how = find_item(db, user_id, cand.code, cand.field)
        if item:
            return Resolution(cand.code, item, how, cand.rule.name if cand.rule else None)
    return Resolution(code, None, None, None)
