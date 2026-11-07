"""Customer matching and purchase stats.

A customer is matched by email first, then phone, then exact name (all
case/format-insensitive), so typing the same buyer twice reuses one record.
Totals are computed from what points at the customer:

* invoices: the amount actually paid (cancelled invoices are skipped),
* checkout sales: what the buyer paid per line (gross after discount + tax),
  minus lines that were later refunded.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.customer import Customer
from app.models.invoice import Invoice
from app.models.transaction import Transaction

ZERO = Decimal("0.00")


def normalize_email(value: str | None) -> str | None:
    value = (value or "").strip().lower()
    return value or None


def normalize_phone(value: str | None) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return None
    return f"+{digits}" if raw.startswith("+") else digits


def get_owned_customer(db: Session, user_id, customer_id: UUID) -> Customer:
    customer = db.query(Customer).filter(Customer.id == customer_id, Customer.user_id == user_id).first()
    if not customer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return customer


def find_customer(db: Session, user_id, name: str | None, email: str | None, phone: str | None) -> Customer | None:
    base = db.query(Customer).filter(Customer.user_id == user_id)
    email = normalize_email(email)
    phone = normalize_phone(phone)
    if email:
        hit = base.filter(Customer.email == email).first()
        if hit:
            return hit
    if phone:
        hit = base.filter(Customer.phone == phone).first()
        if hit:
            return hit
    name = (name or "").strip()
    if name and not email and not phone:
        return base.filter(func.lower(Customer.name) == name.lower()).first()
    return None


def upsert_customer(db: Session, user_id, name: str, email: str | None = None, phone: str | None = None) -> Customer | None:
    """Reuse the matching customer (filling in missing contact details) or add one."""
    name = (name or "").strip()
    if not name:
        return None
    email_n = normalize_email(email)
    phone_n = normalize_phone(phone)
    customer = find_customer(db, user_id, name, email_n, phone_n)
    if customer:
        if email_n and not customer.email:
            customer.email = email_n
        if phone_n and not customer.phone:
            customer.phone = phone_n
        db.add(customer)
        return customer
    customer = Customer(user_id=user_id, name=name[:255], email=email_n, phone=phone_n)
    db.add(customer)
    db.flush()
    return customer


@dataclass
class CustomerStats:
    order_count: int = 0
    total_spent: Decimal = ZERO
    last_purchase_at: datetime | None = None


@dataclass
class CustomerHistory:
    invoices: list[Invoice] = field(default_factory=list)
    orders: list[dict] = field(default_factory=list)


def _sale_rows(db: Session, user_id, customer_ids: list[UUID] | None = None):
    query = db.query(Transaction).filter(
        Transaction.user_id == user_id,
        Transaction.customer_id.isnot(None),
        Transaction.invoice_id.is_(None),
        Transaction.is_refund.is_(False),
    )
    if customer_ids is not None:
        query = query.filter(Transaction.customer_id.in_(customer_ids))
    return query.all()


def _invoice_rows(db: Session, user_id, customer_ids: list[UUID] | None = None):
    query = db.query(Invoice).filter(
        Invoice.user_id == user_id,
        Invoice.customer_id.isnot(None),
        Invoice.status != "cancelled",
    )
    if customer_ids is not None:
        query = query.filter(Invoice.customer_id.in_(customer_ids))
    return query.all()


def _line_paid(txn: Transaction) -> Decimal:
    if txn.status == "refunded":
        return ZERO
    return Decimal(str(txn.gross_amount or 0)) + Decimal(str(txn.tax_amount or 0))


def compute_stats(db: Session, user_id, customer_ids: list[UUID] | None = None) -> dict[UUID, CustomerStats]:
    stats: dict[UUID, CustomerStats] = {}
    orders_seen: dict[UUID, set] = {}

    def bump(cid: UUID, when: datetime | None) -> CustomerStats:
        entry = stats.setdefault(cid, CustomerStats())
        if when and (entry.last_purchase_at is None or when > entry.last_purchase_at):
            entry.last_purchase_at = when
        return entry

    for invoice in _invoice_rows(db, user_id, customer_ids):
        entry = bump(invoice.customer_id, invoice.created_at)
        entry.order_count += 1
        entry.total_spent += Decimal(str(invoice.amount_paid or 0))
    for txn in _sale_rows(db, user_id, customer_ids):
        entry = bump(txn.customer_id, txn.created_at)
        key = txn.order_id or txn.id
        seen = orders_seen.setdefault(txn.customer_id, set())
        if key not in seen:
            seen.add(key)
            entry.order_count += 1
        entry.total_spent += _line_paid(txn)
    for entry in stats.values():
        entry.total_spent = entry.total_spent.quantize(Decimal("0.01"))
    return stats


def customer_history(db: Session, user_id, customer_id: UUID) -> CustomerHistory:
    history = CustomerHistory()
    history.invoices = sorted(
        db.query(Invoice).filter(Invoice.user_id == user_id, Invoice.customer_id == customer_id).all(),
        key=lambda i: i.created_at,
        reverse=True,
    )
    grouped: dict = {}
    for txn in _sale_rows(db, user_id, [customer_id]):
        key = txn.order_id or txn.id
        order = grouped.setdefault(key, {
            "order_id": txn.order_id,
            "transaction_id": txn.id,
            "created_at": txn.created_at,
            "total": ZERO,
            "item_count": 0,
            "refunded": True,
        })
        order["total"] += Decimal(str(txn.gross_amount or 0)) + Decimal(str(txn.tax_amount or 0))
        order["item_count"] += txn.quantity or 1
        order["refunded"] = order["refunded"] and txn.status == "refunded"
        if txn.created_at and txn.created_at < order["created_at"]:
            order["created_at"] = txn.created_at
    history.orders = sorted(grouped.values(), key=lambda o: o["created_at"], reverse=True)
    return history
