"""Smart scan: barcode memory built only from the seller's own confirmed saves.

Lookup order for a scanned barcode:
  1. scan memory   — this barcode was confirmed before (corrections win)
  2. inventory     — an existing item already carries this UPC
  3. style family  — a sibling barcode with the same style code (size left blank)
No outside services are called.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.inventory import InventoryItem
from app.models.scan_memory import ScanMemory
from app.models.user import User

router = APIRouter(prefix="/scan", tags=["scan"])

FIELD_KEYS = (
    "name", "brand", "category", "sku", "style_code", "size", "color",
    "condition", "buy_price", "expected_sell_price", "platform",
)
# Fields that describe one exact box; not copied across a style family.
PER_BOX_KEYS = ("size",)


def normalize_barcode(raw: str) -> str:
    code = "".join(ch for ch in raw.strip() if ch.isalnum()).upper()
    # A UPC-A read as EAN-13 gains a leading zero; store one canonical form.
    if len(code) == 13 and code.isdigit() and code.startswith("0"):
        code = code[1:]
    return code


def normalize_style(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    code = raw.strip().upper().replace(" ", "")
    return code or None


def _clean_fields(raw: dict) -> dict:
    out = {}
    for key in FIELD_KEYS:
        val = raw.get(key)
        if val is None:
            continue
        text = str(val).strip()
        if text:
            out[key] = text[:200]
    return out


class LearnBody(BaseModel):
    barcode: str = Field(min_length=4, max_length=64)
    fields: dict

    @field_validator("barcode")
    @classmethod
    def _barcode(cls, v: str) -> str:
        code = normalize_barcode(v)
        if len(code) < 4:
            raise ValueError("barcode too short")
        return code


class ScanResult(BaseModel):
    barcode: str
    match: Optional[str]  # "memory" | "inventory" | "style" | None
    fields: dict
    times_seen: int = 0


def _item_fields(item: InventoryItem) -> dict:
    attrs = item.custom_attributes or {}
    return _clean_fields({
        "name": item.name, "category": item.category, "sku": item.sku,
        "style_code": attrs.get("style_code") or item.sku, "size": item.size,
        "color": item.color, "condition": item.condition,
        "buy_price": item.buy_price, "expected_sell_price": item.expected_sell_price,
        "platform": item.platform, "brand": attrs.get("brand"),
    })


@router.get("/lookup", response_model=ScanResult)
def lookup(
    barcode: str = Query(min_length=4, max_length=64),
    style_code: Optional[str] = Query(default=None, max_length=64),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    code = normalize_barcode(barcode)
    mem = db.query(ScanMemory).filter_by(user_id=current_user.id, barcode=code).first()
    if mem:
        return ScanResult(barcode=code, match="memory", fields=mem.fields or {}, times_seen=mem.times_seen)

    candidates = {code, "0" + code} if len(code) == 12 else {code}
    item = (
        db.query(InventoryItem)
        .filter(InventoryItem.user_id == current_user.id, InventoryItem.upc.in_(candidates))
        .order_by(InventoryItem.created_at.desc())
        .first()
    )
    if item:
        return ScanResult(barcode=code, match="inventory", fields=_item_fields(item))

    style = normalize_style(style_code)
    if style:
        sibling = (
            db.query(ScanMemory)
            .filter_by(user_id=current_user.id, style_code=style)
            .order_by(ScanMemory.updated_at.desc())
            .first()
        )
        if sibling:
            fields = {k: v for k, v in (sibling.fields or {}).items() if k not in PER_BOX_KEYS}
            return ScanResult(barcode=code, match="style", fields=fields)

    return ScanResult(barcode=code, match=None, fields={})


@router.post("/learn", response_model=ScanResult)
def learn(
    body: LearnBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    fields = _clean_fields(body.fields)
    if not fields.get("name"):
        raise HTTPException(status_code=422, detail="A name is required to remember a barcode.")
    style = normalize_style(fields.get("style_code"))
    if style:
        fields["style_code"] = style
    mem = (
        db.query(ScanMemory)
        .filter_by(user_id=current_user.id, barcode=body.barcode)
        .with_for_update()
        .first()
    )
    if mem:
        mem.fields = fields
        mem.style_code = style
        mem.times_seen = (mem.times_seen or 0) + 1
    else:
        mem = ScanMemory(user_id=current_user.id, barcode=body.barcode, style_code=style, fields=fields, times_seen=1)
        db.add(mem)
    db.commit()
    db.refresh(mem)
    return ScanResult(barcode=mem.barcode, match="memory", fields=mem.fields, times_seen=mem.times_seen)


@router.get("/memory", response_model=list[ScanResult])
def list_memory(
    limit: int = Query(default=2000, ge=1, le=5000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download the account's barcode memory so scanning works offline."""
    rows = (
        db.query(ScanMemory)
        .filter_by(user_id=current_user.id)
        .order_by(ScanMemory.updated_at.desc())
        .limit(limit)
        .all()
    )
    return [ScanResult(barcode=r.barcode, match="memory", fields=r.fields or {}, times_seen=r.times_seen) for r in rows]


@router.delete("/memory/{barcode}", status_code=status.HTTP_204_NO_CONTENT)
def forget(
    barcode: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    code = normalize_barcode(barcode)
    deleted = db.query(ScanMemory).filter_by(user_id=current_user.id, barcode=code).delete()
    db.commit()
    if not deleted:
        raise HTTPException(status_code=404, detail="Barcode not remembered.")
