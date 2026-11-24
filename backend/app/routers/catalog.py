"""Resqlo codes: one universal code per real product, shared by every store."""
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.catalog import CatalogBarcode, CatalogProduct
from app.models.inventory import InventoryItem
from app.models.user import User
from app.services import catalog
from app.services.barcode_rules import clean_code

router = APIRouter(tags=["catalog"])


class CatalogProductOut(BaseModel):
    rq_code: str
    style_code: str
    size: Optional[str] = None
    name: str
    brand: Optional[str] = None
    category: Optional[str] = None
    color: Optional[str] = None
    times_confirmed: int = 1


class CatalogStats(BaseModel):
    products: int
    styles: int
    barcodes: int


def _out(product: CatalogProduct) -> CatalogProductOut:
    return CatalogProductOut(
        rq_code=product.rq_code, style_code=product.style_code, size=product.size or None,
        name=product.name, brand=product.brand, category=product.category, color=product.color,
        times_confirmed=product.times_confirmed or 1,
    )


@router.get("/catalog/stats", response_model=CatalogStats)
def stats(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return CatalogStats(
        products=db.query(func.count(CatalogProduct.id)).scalar() or 0,
        styles=db.query(func.count(func.distinct(CatalogProduct.style_code))).scalar() or 0,
        barcodes=db.query(func.count(CatalogBarcode.code)).scalar() or 0,
    )


@router.get("/catalog/{code}", response_model=CatalogProductOut)
def lookup(code: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    product = catalog.find(db, clean_code(code))
    if not product:
        raise HTTPException(status_code=404, detail="Not in the Resqlo catalog yet.")
    return _out(product)


@router.post("/inventory/{item_id}/rq-code", response_model=CatalogProductOut)
def assign(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Give an item its Resqlo code (the same code every store uses for this product)."""
    item = (
        db.query(InventoryItem)
        .filter(InventoryItem.id == item_id, InventoryItem.user_id == current_user.id, InventoryItem.deleted_at.is_(None))
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    product = catalog.contribute(db, catalog.item_facts(item), item.upc)
    if not product:
        raise HTTPException(status_code=422, detail="Add a style code (or SKU) and a name to get a Resqlo code.")
    db.commit()
    return _out(product)


# ─── Admin: fix wrong entries in the shared catalog ──────────────────────────

def is_catalog_admin(user: User) -> bool:
    from app.config import settings

    allowed = {e.strip().lower() for e in settings.CATALOG_ADMIN_EMAILS.split(",") if e.strip()}
    return (user.email or "").lower() in allowed


def require_catalog_admin(current_user: User = Depends(get_current_user)) -> User:
    if not is_catalog_admin(current_user):
        raise HTTPException(status_code=403, detail="Catalog admins only.")
    return current_user


class AdminAccess(BaseModel):
    admin: bool


class AdminProduct(CatalogProductOut):
    barcodes: list[str] = []


class AdminProductUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    style_code: str = Field(min_length=1, max_length=64)
    size: Optional[str] = Field(default=None, max_length=32)
    brand: Optional[str] = Field(default=None, max_length=200)
    category: Optional[str] = Field(default=None, max_length=200)
    color: Optional[str] = Field(default=None, max_length=200)


def _admin_out(db: Session, product: CatalogProduct) -> AdminProduct:
    codes = [b.code for b in db.query(CatalogBarcode).filter_by(product_id=product.id).order_by(CatalogBarcode.code)]
    return AdminProduct(**_out(product).model_dump(), barcodes=codes)


def _admin_get(db: Session, rq_code: str) -> CatalogProduct:
    product = db.query(CatalogProduct).filter_by(rq_code=clean_code(rq_code)).first()
    if not product:
        raise HTTPException(status_code=404, detail="Not in the Resqlo catalog.")
    return product


@router.get("/catalog/admin/access", response_model=AdminAccess)
def admin_access(current_user: User = Depends(get_current_user)):
    return AdminAccess(admin=is_catalog_admin(current_user))


@router.get("/catalog/admin/products", response_model=list[AdminProduct])
def admin_search(
    q: str = Query(default="", max_length=200),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    admin: User = Depends(require_catalog_admin),
):
    query = db.query(CatalogProduct)
    term = q.strip()
    if term:
        code = clean_code(term)
        like = f"%{term.upper()}%"
        by_barcode = db.query(CatalogBarcode.product_id).filter(CatalogBarcode.code == code)
        query = query.filter(or_(
            CatalogProduct.rq_code == code,
            CatalogProduct.style_code.like(f"%{code}%"),
            func.upper(CatalogProduct.name).like(like),
            func.upper(func.coalesce(CatalogProduct.brand, "")).like(like),
            CatalogProduct.id.in_(by_barcode),
        ))
    rows = query.order_by(CatalogProduct.updated_at.desc()).limit(limit).all()
    return [_admin_out(db, p) for p in rows]


@router.put("/catalog/admin/products/{rq_code}", response_model=AdminProduct)
def admin_update(
    rq_code: str,
    body: AdminProductUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_catalog_admin),
):
    product = _admin_get(db, rq_code)
    style = catalog.normalize_style(body.style_code)
    size = catalog.normalize_size(body.size)
    clash = (
        db.query(CatalogProduct)
        .filter(CatalogProduct.style_code == style, CatalogProduct.size == size, CatalogProduct.id != product.id)
        .first()
    )
    if clash:
        raise HTTPException(status_code=409, detail=f"{clash.rq_code} is already {style} size {size or '(none)'}.")
    product.style_code, product.size, product.name = style, size, body.name.strip()
    for key in ("brand", "category", "color"):
        val = (getattr(body, key) or "").strip()
        setattr(product, key, val or None)
    db.commit()
    return _admin_out(db, product)


@router.delete("/catalog/admin/products/{rq_code}", status_code=204)
def admin_delete(rq_code: str, db: Session = Depends(get_db), admin: User = Depends(require_catalog_admin)):
    db.delete(_admin_get(db, rq_code))
    db.commit()


@router.delete("/catalog/admin/barcodes/{code}", status_code=204)
def admin_unlink(code: str, db: Session = Depends(get_db), admin: User = Depends(require_catalog_admin)):
    if not db.query(CatalogBarcode).filter_by(code=clean_code(code)).delete():
        raise HTTPException(status_code=404, detail="Barcode not in the catalog.")
    db.commit()
