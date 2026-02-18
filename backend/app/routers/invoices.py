"""Invoice router — CRUD + state machine transitions.

Endpoints:
    POST   /api/v1/invoices          — Create invoice with line items
    GET    /api/v1/invoices          — List user's invoices
    GET    /api/v1/invoices/{id}     — Get single invoice
    PATCH  /api/v1/invoices/{id}/status — Transition invoice status
    POST   /api/v1/invoices/{id}/pay   — Create Stripe PaymentIntent (Pro only)
"""
from decimal import Decimal
from math import ceil

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.models.invoice import Invoice, InvoiceItem
from app.models.inventory import InventoryItem
from app.schemas.invoice import (
    InvoiceCreate,
    InvoiceResponse,
    InvoiceListResponse,
    InvoiceItemResponse,
    InvoiceStatusUpdate,
)
from app.services.invoice import (
    calculate_invoice_totals,
    transition_invoice,
    process_invoice_payment,
)
from app.services.stripe_service import create_payment_intent

router = APIRouter(prefix="/invoices", tags=["invoices"])


def _invoice_to_response(invoice: Invoice, db: Session) -> InvoiceResponse:
    """Convert Invoice model + items to response schema."""
    items = db.query(InvoiceItem).filter(
        InvoiceItem.invoice_id == invoice.id
    ).all()

    return InvoiceResponse(
        id=invoice.id,
        user_id=invoice.user_id,
        customer_name=invoice.customer_name,
        customer_email=invoice.customer_email,
        status=invoice.status,
        subtotal=invoice.subtotal,
        tax=invoice.tax,
        shipping=invoice.shipping,
        discount=invoice.discount,
        total=invoice.total,
        stripe_payment_intent_id=invoice.stripe_payment_intent_id,
        notes=invoice.notes,
        items=[InvoiceItemResponse.model_validate(i) for i in items],
        created_at=invoice.created_at,
        updated_at=invoice.updated_at,
    )


@router.post("", response_model=InvoiceResponse, status_code=status.HTTP_201_CREATED)
def create_invoice(
    payload: InvoiceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create an invoice with line items.

    Pro tier required for Stripe features, but all tiers can create invoices.
    """
    # Validate inventory items ownership if linked
    for item in payload.items:
        if item.inventory_item_id:
            inv = db.query(InventoryItem).filter(
                InventoryItem.id == item.inventory_item_id,
                InventoryItem.user_id == current_user.id,
                InventoryItem.deleted_at.is_(None),
            ).first()
            if not inv:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Inventory item {item.inventory_item_id} not found.",
                )

    # Calculate totals
    totals = calculate_invoice_totals(
        payload.items, payload.tax, payload.shipping, payload.discount
    )

    # Create invoice
    invoice = Invoice(
        user_id=current_user.id,
        customer_name=payload.customer_name,
        customer_email=payload.customer_email,
        subtotal=totals["subtotal"],
        tax=payload.tax,
        shipping=payload.shipping,
        discount=payload.discount,
        total=totals["total"],
        notes=payload.notes,
    )
    db.add(invoice)
    db.flush()

    # Create line items
    for item_data, line_total in zip(payload.items, totals["line_totals"]):
        line_item = InvoiceItem(
            invoice_id=invoice.id,
            inventory_item_id=item_data.inventory_item_id,
            description=item_data.description,
            quantity=item_data.quantity,
            unit_price=item_data.unit_price,
            line_total=line_total,
        )
        db.add(line_item)

    db.commit()
    db.refresh(invoice)

    return _invoice_to_response(invoice, db)


@router.get("", response_model=InvoiceListResponse)
def list_invoices(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    status_filter: str = Query(None, alias="status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List user's invoices with optional status filter."""
    query = db.query(Invoice).filter(Invoice.user_id == current_user.id)
    if status_filter:
        query = query.filter(Invoice.status == status_filter)

    total = query.count()
    invoices = (
        query
        .order_by(Invoice.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )

    return InvoiceListResponse(
        items=[_invoice_to_response(inv, db) for inv in invoices],
        total=total,
        page=page,
        per_page=per_page,
        pages=ceil(total / per_page) if total else 0,
    )


@router.get("/{invoice_id}", response_model=InvoiceResponse)
def get_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    invoice = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.user_id == current_user.id,
    ).first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return _invoice_to_response(invoice, db)


@router.patch("/{invoice_id}/status", response_model=InvoiceResponse)
def update_invoice_status(
    invoice_id: str,
    payload: InvoiceStatusUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Transition invoice status per state machine.

    When transitioned to 'paid' (manually), also creates transactions
    and updates inventory items.
    """
    invoice = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.user_id == current_user.id,
    ).first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    updated = transition_invoice(invoice, payload.status, db)

    # If manually marked as paid, process the payment
    if payload.status == "paid":
        process_invoice_payment(updated, db)

    return _invoice_to_response(updated, db)


@router.post("/{invoice_id}/pay")
def create_invoice_payment(
    invoice_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a Stripe PaymentIntent for the invoice (Pro tier only)."""
    invoice = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.user_id == current_user.id,
    ).first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    return create_payment_intent(db, invoice, current_user)
