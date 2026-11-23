"""Resqlo codes: one universal code per real product, shared by every store."""
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
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
