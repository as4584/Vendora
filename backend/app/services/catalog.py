"""Resqlo universal catalog: every real product gets one Resqlo code.

A product is a style code + size ("DD1391-100" size "10"). Any store's saves
grow the catalog: the product facts (name, brand, category, colour) and the
manufacturer barcodes printed on the box. Prices, quantities, condition and
anything else about a store's business never leave that store.
"""
from __future__ import annotations

import secrets
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.catalog import CatalogBarcode, CatalogProduct
from app.models.inventory import InventoryItem

RQ_PREFIX = "RQ-"
# Crockford base32: no I, L, O or U, so codes read aloud and typed by hand survive.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_CODE_LEN = 7
PRODUCT_KEYS = ("name", "brand", "category", "color")


def new_rq_code() -> str:
    return RQ_PREFIX + "".join(secrets.choice(_ALPHABET) for _ in range(_CODE_LEN))


def is_rq_code(code: str) -> bool:
    body = code[len(RQ_PREFIX):]
    return code.startswith(RQ_PREFIX) and len(body) == _CODE_LEN and all(c in _ALPHABET for c in body)


def normalize_style(raw: Optional[str]) -> Optional[str]:
    code = (raw or "").strip().upper().replace(" ", "")
    return code[:64] or None


def normalize_size(raw: Optional[str]) -> str:
    size = " ".join(str(raw or "").upper().split())
    for prefix in ("US ", "SIZE "):
        if size.startswith(prefix):
            size = size[len(prefix):]
    return size[:32]


def is_manufacturer_barcode(code: str) -> bool:
    """UPC/EAN/GTIN only: store-made tags mean nothing outside that store."""
    return code.isdigit() and len(code) in (8, 12, 13, 14)


def _barcode_forms(code: str) -> list[str]:
    forms = {code}
    if code.isdigit():
        if len(code) == 12:
            forms.add("0" + code)
        if len(code) == 13 and code.startswith("0"):
            forms.add(code[1:])
    return sorted(forms)


def _canonical_barcode(code: str) -> str:
    return code[1:] if len(code) == 13 and code.startswith("0") else code


def product_fields(product: CatalogProduct) -> dict:
    out = {"style_code": product.style_code, "rq_code": product.rq_code}
    if product.size:
        out["size"] = product.size
    for key in PRODUCT_KEYS:
        val = getattr(product, key)
        if val:
            out[key] = val
    return out


def _get(db: Session, style: str, size: str) -> Optional[CatalogProduct]:
    return db.query(CatalogProduct).filter_by(style_code=style, size=size).first()


def get_or_create(db: Session, style: str, size: str, name: str) -> CatalogProduct:
    product = _get(db, style, size)
    if product:
        return product
    for _ in range(5):
        try:
            with db.begin_nested():
                product = CatalogProduct(rq_code=new_rq_code(), style_code=style, size=size, name=name[:200], times_confirmed=0)
                db.add(product)
            return product
        except IntegrityError:
            # Another store created it at the same moment, or (rarely) the code was taken.
            product = _get(db, style, size)
            if product:
                return product
    raise RuntimeError("Could not assign a Resqlo code")  # pragma: no cover - 32^7 codes


def contribute(db: Session, fields: dict, barcode: Optional[str] = None, confirmed: bool = False) -> Optional[CatalogProduct]:
    """Add what a store saved to the shared catalog. Does not commit.

    Needs a style code and a name. Fills facts the catalog doesn't have yet
    and links a manufacturer barcode the first time it's seen.
    """
    style = normalize_style(fields.get("style_code"))
    name = str(fields.get("name") or "").strip()
    if not style or not name:
        return None
    product = get_or_create(db, style, normalize_size(fields.get("size")), name)
    for key in PRODUCT_KEYS:
        val = str(fields.get(key) or "").strip()
        if val and not getattr(product, key):
            setattr(product, key, val[:200])
    if confirmed:
        product.times_confirmed = (product.times_confirmed or 0) + 1
    if barcode and is_manufacturer_barcode(barcode):
        forms = _barcode_forms(barcode)
        if not db.query(CatalogBarcode).filter(CatalogBarcode.code.in_(forms)).first():
            try:
                with db.begin_nested():
                    db.add(CatalogBarcode(code=_canonical_barcode(barcode), product_id=product.id))
            except IntegrityError:
                pass  # linked by another store at the same moment
    db.flush()
    return product


def find(db: Session, code: str) -> Optional[CatalogProduct]:
    """A Resqlo code or a manufacturer barcode -> catalog product."""
    if is_rq_code(code):
        return db.query(CatalogProduct).filter_by(rq_code=code).first()
    link = db.query(CatalogBarcode).filter(CatalogBarcode.code.in_(_barcode_forms(code))).first()
    return db.get(CatalogProduct, link.product_id) if link else None


def first_of_style(db: Session, style: Optional[str]) -> Optional[CatalogProduct]:
    style = normalize_style(style)
    if not style:
        return None
    return db.query(CatalogProduct).filter_by(style_code=style).order_by(CatalogProduct.times_confirmed.desc()).first()


def item_style(item: InventoryItem) -> Optional[str]:
    attrs = item.custom_attributes or {}
    return normalize_style(attrs.get("style_code") or item.sku)


def item_facts(item: InventoryItem) -> dict:
    attrs = item.custom_attributes or {}
    return {
        "style_code": item_style(item), "size": item.size, "name": item.name,
        "brand": attrs.get("brand"), "category": item.category, "color": item.color,
    }


def items_for_product(db: Session, user_id, product: CatalogProduct):
    """This store's live items that are this catalog product."""
    from sqlalchemy import func

    query = db.query(InventoryItem).filter(
        InventoryItem.user_id == user_id,
        InventoryItem.deleted_at.is_(None),
        func.upper(func.replace(func.coalesce(InventoryItem.custom_attributes["style_code"].as_string(), InventoryItem.sku), " ", ""))
        == product.style_code,
    )
    candidates = query.order_by((InventoryItem.quantity > 0).desc(), InventoryItem.created_at.desc()).all()
    return [item for item in candidates if normalize_size(item.size) == product.size]
