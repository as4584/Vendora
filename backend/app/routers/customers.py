"""Customers router.

    GET    /api/v1/customers          List with order count, total spent, last purchase
    POST   /api/v1/customers          Add a customer (reuses a matching one)
    GET    /api/v1/customers/{id}     Detail + purchase history (invoices and checkouts)
    PATCH  /api/v1/customers/{id}     Edit contact details / tax-exempt flag
"""
from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.customer import Customer
from app.models.user import User
from app.schemas.customer import (
    CustomerCreate,
    CustomerDetailResponse,
    CustomerInvoiceSummary,
    CustomerListResponse,
    CustomerOrderSummary,
    CustomerResponse,
    CustomerUpdate,
)
from app.services.customers import (
    CustomerStats,
    compute_stats,
    customer_history,
    get_owned_customer,
    normalize_email,
    normalize_phone,
    upsert_customer,
)

router = APIRouter(prefix="/customers", tags=["customers"])

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _response(customer: Customer, stats: CustomerStats | None) -> CustomerResponse:
    stats = stats or CustomerStats()
    return CustomerResponse(
        id=customer.id,
        name=customer.name,
        email=customer.email,
        phone=customer.phone,
        address=customer.address,
        tax_exempt=bool(customer.tax_exempt),
        notes=customer.notes,
        order_count=stats.order_count,
        total_spent=stats.total_spent,
        last_purchase_at=stats.last_purchase_at,
        created_at=customer.created_at,
    )


@router.get("", response_model=CustomerListResponse)
def list_customers(
    q: str | None = Query(None, max_length=100),
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Customer).filter(Customer.user_id == current_user.id)
    term = (q or "").strip()
    if term:
        like = f"%{term.lower()}%"
        clauses = [func.lower(Customer.name).like(like), Customer.email.like(like)]
        digits = normalize_phone(term)
        if digits:
            clauses.append(Customer.phone.like(f"%{digits.lstrip('+')}%"))
        query = query.filter(or_(*clauses))
    customers = query.all()
    stats = compute_stats(db, current_user.id, [c.id for c in customers]) if customers else {}
    customers.sort(
        key=lambda c: (stats.get(c.id, CustomerStats()).last_purchase_at or c.created_at or _EPOCH),
        reverse=True,
    )
    customers = customers[:limit]
    return CustomerListResponse(
        items=[_response(c, stats.get(c.id)) for c in customers],
        total=len(customers),
    )


@router.post("", response_model=CustomerResponse, status_code=status.HTTP_201_CREATED)
def create_customer(
    payload: CustomerCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    customer = upsert_customer(db, current_user.id, payload.name, payload.email, payload.phone)
    if payload.address is not None:
        customer.address = payload.address.strip() or None
    if payload.notes is not None:
        customer.notes = payload.notes.strip() or None
    if payload.tax_exempt:
        customer.tax_exempt = True
    db.add(customer)
    db.commit()
    db.refresh(customer)
    return _response(customer, compute_stats(db, current_user.id, [customer.id]).get(customer.id))


@router.get("/{customer_id}", response_model=CustomerDetailResponse)
def get_customer(
    customer_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    customer = get_owned_customer(db, current_user.id, customer_id)
    stats = compute_stats(db, current_user.id, [customer.id]).get(customer.id)
    history = customer_history(db, current_user.id, customer.id)
    base = _response(customer, stats).model_dump()
    return CustomerDetailResponse(
        **base,
        invoices=[
            CustomerInvoiceSummary(
                id=i.id,
                invoice_number=i.invoice_number,
                status=i.status,
                total=i.total,
                amount_paid=i.amount_paid if i.amount_paid is not None else Decimal("0.00"),
                created_at=i.created_at,
            )
            for i in history.invoices
        ],
        orders=[CustomerOrderSummary(**o) for o in history.orders],
    )


@router.patch("/{customer_id}", response_model=CustomerResponse)
def update_customer(
    customer_id: UUID,
    payload: CustomerUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    customer = get_owned_customer(db, current_user.id, customer_id)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"]:
        customer.name = data["name"].strip()
    if "email" in data:
        customer.email = normalize_email(data["email"])
    if "phone" in data:
        customer.phone = normalize_phone(data["phone"])
    if "address" in data:
        customer.address = (data["address"] or "").strip() or None
    if "notes" in data:
        customer.notes = (data["notes"] or "").strip() or None
    if data.get("tax_exempt") is not None:
        customer.tax_exempt = data["tax_exempt"]
    db.add(customer)
    db.commit()
    db.refresh(customer)
    return _response(customer, compute_stats(db, current_user.id, [customer.id]).get(customer.id))
