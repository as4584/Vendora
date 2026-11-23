"""Barcode control: resolve any scan, seller rules, and linked store barcodes."""
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.barcode import BarcodeRule, ItemBarcode
from app.models.inventory import InventoryItem
from app.models.user import User
from app.schemas.inventory import ItemResponse
from app.services import barcode_rules

router = APIRouter(tags=["barcodes"])

MAX_RULES = 50
MAX_LINKS_PER_ITEM = 20


class ResolveResponse(BaseModel):
    code: str
    matched_by: Optional[str]
    rule_name: Optional[str]
    item: Optional[ItemResponse]


@router.get("/scan/resolve", response_model=ResolveResponse)
def resolve_scan(
    code: str = Query(min_length=1, max_length=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Find the item a scanned code means, using the seller's rules and links."""
    result = barcode_rules.resolve(db, current_user.id, code)
    return ResolveResponse(
        code=result.code,
        matched_by=result.matched_by,
        rule_name=result.rule_name,
        item=ItemResponse.model_validate(result.item) if result.item else None,
    )


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    prefix: Optional[str] = Field(default=None, max_length=32)
    suffix: Optional[str] = Field(default=None, max_length=32)
    min_length: Optional[int] = Field(default=None, ge=1, le=64)
    max_length: Optional[int] = Field(default=None, ge=1, le=64)
    strip_prefix: bool = True
    strip_suffix: bool = True
    slice_start: Optional[int] = Field(default=None, ge=1, le=64)
    slice_length: Optional[int] = Field(default=None, ge=1, le=64)
    lookup_field: Literal["auto", "sku", "upc", "linked"] = "auto"
    enabled: bool = True

    @model_validator(mode="after")
    def _check(self):
        self.prefix = barcode_rules.clean_code(self.prefix) if self.prefix else None
        self.suffix = barcode_rules.clean_code(self.suffix) if self.suffix else None
        if not (self.prefix or self.suffix or self.min_length or self.max_length):
            raise ValueError("A rule needs a 'starts with', 'ends with' or length to know which codes it covers.")
        if self.min_length and self.max_length and self.min_length > self.max_length:
            raise ValueError("Shortest length can't be more than longest length.")
        return self


class RuleOut(RuleIn):
    id: UUID
    position: int

    model_config = {"from_attributes": True}


class RuleOrder(BaseModel):
    ids: list[UUID]


def _rule(db: Session, user: User, rule_id: UUID) -> BarcodeRule:
    rule = db.query(BarcodeRule).filter_by(id=rule_id, user_id=user.id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found.")
    return rule


@router.get("/scan/rules", response_model=list[RuleOut])
def list_rules(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return barcode_rules.user_rules(db, current_user.id)


@router.post("/scan/rules", response_model=RuleOut, status_code=status.HTTP_201_CREATED)
def create_rule(body: RuleIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    count = db.query(func.count(BarcodeRule.id)).filter_by(user_id=current_user.id).scalar() or 0
    if count >= MAX_RULES:
        raise HTTPException(status_code=409, detail=f"You can have up to {MAX_RULES} barcode rules.")
    top = db.query(func.max(BarcodeRule.position)).filter_by(user_id=current_user.id).scalar()
    rule = BarcodeRule(user_id=current_user.id, position=(top + 1) if top is not None else 0, **body.model_dump())
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.put("/scan/rules/{rule_id}", response_model=RuleOut)
def update_rule(
    rule_id: UUID, body: RuleIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    rule = _rule(db, current_user, rule_id)
    for key, value in body.model_dump().items():
        setattr(rule, key, value)
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/scan/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rule(rule_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    db.delete(_rule(db, current_user, rule_id))
    db.commit()


@router.post("/scan/rules/order", response_model=list[RuleOut])
def reorder_rules(body: RuleOrder, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Rules run top to bottom; the first one that finds an item wins."""
    rules = {rule.id: rule for rule in barcode_rules.user_rules(db, current_user.id)}
    if set(body.ids) != set(rules):
        raise HTTPException(status_code=400, detail="Send every rule id exactly once.")
    for position, rule_id in enumerate(body.ids):
        rules[rule_id].position = position
    db.commit()
    return barcode_rules.user_rules(db, current_user.id)


class LinkIn(BaseModel):
    code: str = Field(min_length=1, max_length=200)
    replace: bool = False  # move the code off another item onto this one


class LinkOut(BaseModel):
    code: str
    inventory_item_id: UUID

    model_config = {"from_attributes": True}


def _item(db: Session, user: User, item_id: UUID) -> InventoryItem:
    item = db.query(InventoryItem).filter(
        InventoryItem.id == item_id,
        InventoryItem.user_id == user.id,
        InventoryItem.deleted_at.is_(None),
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")
    return item


@router.get("/inventory/{item_id}/barcodes", response_model=list[LinkOut])
def list_links(item_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = _item(db, current_user, item_id)
    return (
        db.query(ItemBarcode)
        .filter_by(user_id=current_user.id, inventory_item_id=item.id)
        .order_by(ItemBarcode.created_at)
        .all()
    )


@router.post("/inventory/{item_id}/barcodes", response_model=LinkOut, status_code=status.HTTP_201_CREATED)
def link_code(
    item_id: UUID, body: LinkIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """Teach Resqlo that a store's own barcode means this item."""
    item = _item(db, current_user, item_id)
    code = barcode_rules.clean_code(body.code)
    if not code:
        raise HTTPException(status_code=422, detail="Barcode is empty.")
    existing = db.query(ItemBarcode).filter_by(user_id=current_user.id, code=code).first()
    if existing and existing.inventory_item_id == item.id:
        return existing
    if existing:
        if not body.replace:
            other = db.get(InventoryItem, existing.inventory_item_id)
            name = other.name if other else "another item"
            raise HTTPException(status_code=409, detail=f"This barcode is already linked to {name}.")
        existing.inventory_item_id = item.id
        db.commit()
        return existing
    links = db.query(func.count(ItemBarcode.id)).filter_by(inventory_item_id=item.id).scalar() or 0
    if links >= MAX_LINKS_PER_ITEM:
        raise HTTPException(status_code=409, detail=f"An item can have up to {MAX_LINKS_PER_ITEM} linked barcodes.")
    link = ItemBarcode(user_id=current_user.id, inventory_item_id=item.id, code=code)
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


@router.delete("/inventory/{item_id}/barcodes/{code}", status_code=status.HTTP_204_NO_CONTENT)
def unlink_code(
    item_id: UUID, code: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    item = _item(db, current_user, item_id)
    link = db.query(ItemBarcode).filter_by(
        user_id=current_user.id, inventory_item_id=item.id, code=barcode_rules.clean_code(code)
    ).first()
    if not link:
        raise HTTPException(status_code=404, detail="Barcode not linked to this item.")
    db.delete(link)
    db.commit()
