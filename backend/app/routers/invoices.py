"""Invoice router — CRUD + state machine transitions.

Endpoints:
    POST   /api/v1/invoices          — Create invoice with line items
    GET    /api/v1/invoices          — List user's invoices
    GET    /api/v1/invoices/{id}     — Get single invoice
    PATCH  /api/v1/invoices/{id}/status — Transition invoice status
    POST   /api/v1/invoices/{id}/payments — Record a partial/full payment
    POST   /api/v1/invoices/{id}/pay   — Create Stripe PaymentIntent (Pro only)
"""
import base64
from decimal import Decimal
from math import ceil

from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.models.invoice import Invoice, InvoiceItem, InvoicePayment
from app.models.inventory import InventoryItem
from app.schemas.invoice import (
    InvoiceCreate,
    InvoiceUpdate,
    InvoiceResponse,
    InvoiceListResponse,
    InvoiceItemResponse,
    InvoiceStatusUpdate,
    InvoicePaymentCreate,
    InvoicePaymentResponse,
)
from app.services.invoice import (
    calculate_invoice_totals,
    check_invoice_item_availability,
    transition_invoice,
    record_invoice_payment,
)
from app.services.invoice_pdf import generate_invoice_pdf
from app.services.customers import get_owned_customer, upsert_customer
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
        number=invoice.number,
        invoice_number=invoice.invoice_number,
        customer_name=invoice.customer_name,
        customer_email=invoice.customer_email,
        customer_phone=invoice.customer_phone,
        customer_id=invoice.customer_id,
        status=invoice.status,
        subtotal=invoice.subtotal,
        tax=invoice.tax,
        shipping=invoice.shipping,
        discount=invoice.discount,
        total=invoice.total,
        stripe_payment_intent_id=invoice.stripe_payment_intent_id,
        notes=invoice.notes,
        items=[InvoiceItemResponse.model_validate(i) for i in items],
        amount_paid=invoice.amount_paid if invoice.amount_paid is not None else Decimal("0.00"),
        balance_due=invoice.balance_due,
        payments=[
            InvoicePaymentResponse.model_validate(p)
            for p in db.query(InvoicePayment)
            .filter(InvoicePayment.invoice_id == invoice.id)
            .order_by(InvoicePayment.created_at)
            .all()
        ],
        created_at=invoice.created_at,
        updated_at=invoice.updated_at,
    )


def _resolve_customer(db: Session, user_id, payload):
    """The picked customer, or the one matching (or made from) the typed details."""
    if getattr(payload, "customer_id", None):
        return get_owned_customer(db, user_id, payload.customer_id)
    return upsert_customer(
        db, user_id, payload.customer_name, payload.customer_email, getattr(payload, "customer_phone", None)
    )


@router.post("", response_model=InvoiceResponse, status_code=status.HTTP_201_CREATED)
def create_invoice(
    payload: InvoiceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create an invoice with line items.

    Pro tier required for Stripe features, but all tiers can create invoices.
    Replays with the same client_request_id (offline outbox) return the
    invoice the first request made, with its server-assigned number.
    """
    if payload.client_request_id:
        existing = db.query(Invoice).filter(
            Invoice.user_id == current_user.id,
            Invoice.client_request_id == payload.client_request_id,
        ).first()
        if existing:
            return _invoice_to_response(existing, db)

    # Validate inventory items ownership and availability if linked
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
            check_invoice_item_availability(inv, item.quantity, item.size_label)

    # Calculate totals
    totals = calculate_invoice_totals(
        payload.items, payload.tax, payload.shipping, payload.discount
    )

    customer = _resolve_customer(db, current_user.id, payload)

    # Create invoice with the next number for this user. Locking the user row
    # serialises concurrent creates so two invoices never share a number.
    db.query(User).filter(User.id == current_user.id).with_for_update().first()
    next_number = (
        db.query(func.max(Invoice.number)).filter(Invoice.user_id == current_user.id).scalar() or 0
    ) + 1
    invoice = Invoice(
        user_id=current_user.id,
        number=next_number,
        customer_name=payload.customer_name,
        customer_email=payload.customer_email,
        customer_phone=payload.customer_phone,
        customer_id=customer.id if customer else None,
        subtotal=totals["subtotal"],
        tax=payload.tax,
        shipping=payload.shipping,
        discount=payload.discount,
        total=totals["total"],
        notes=payload.notes,
        client_request_id=payload.client_request_id,
    )
    db.add(invoice)
    db.flush()

    # Create line items
    for item_data, line_total in zip(payload.items, totals["line_totals"]):
        line_item = InvoiceItem(
            invoice_id=invoice.id,
            inventory_item_id=item_data.inventory_item_id,
            size_label=item_data.size_label,
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
    inventory_item_id: UUID | None = Query(None, description="Filter invoices linked to an inventory item"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List user's invoices with optional status filter."""
    query = db.query(Invoice).filter(Invoice.user_id == current_user.id)
    if status_filter:
        query = query.filter(Invoice.status == status_filter)
    if inventory_item_id:
        query = query.join(InvoiceItem).filter(InvoiceItem.inventory_item_id == inventory_item_id).distinct()

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
    invoice_id: UUID,
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


@router.put("/{invoice_id}", response_model=InvoiceResponse)
def update_invoice(
    invoice_id: UUID,
    payload: InvoiceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update invoice details and line items.

    Allowed only for draft/sent invoices. Paid/cancelled are immutable.
    """
    # A concurrent first payment must finish before editing lines or totals.
    invoice = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.user_id == current_user.id,
    ).with_for_update().first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    if invoice.status in ("paid", "cancelled", "partially_paid"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Paid, partly paid or cancelled invoices cannot be edited",
        )
    if invoice.stripe_payment_intent_id:
        # A customer may already be paying this total; changing it would let
        # the old amount mark the new total as paid.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This invoice has a card payment in progress and can't be edited. Cancel it and create a new invoice.",
        )

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
            check_invoice_item_availability(inv, item.quantity, item.size_label)

    totals = calculate_invoice_totals(
        payload.items, payload.tax, payload.shipping, payload.discount
    )

    invoice.customer_name = payload.customer_name
    invoice.customer_email = payload.customer_email
    invoice.customer_phone = payload.customer_phone
    customer = _resolve_customer(db, current_user.id, payload)
    invoice.customer_id = customer.id if customer else None
    invoice.subtotal = totals["subtotal"]
    invoice.tax = payload.tax
    invoice.shipping = payload.shipping
    invoice.discount = payload.discount
    invoice.total = totals["total"]
    invoice.notes = payload.notes

    db.query(InvoiceItem).filter(InvoiceItem.invoice_id == invoice.id).delete()

    for item_data, line_total in zip(payload.items, totals["line_totals"]):
        line_item = InvoiceItem(
            invoice_id=invoice.id,
            inventory_item_id=item_data.inventory_item_id,
            size_label=item_data.size_label,
            description=item_data.description,
            quantity=item_data.quantity,
            unit_price=item_data.unit_price,
            line_total=line_total,
        )
        db.add(line_item)

    db.add(invoice)
    db.commit()
    db.refresh(invoice)

    return _invoice_to_response(invoice, db)


@router.patch("/{invoice_id}/status", response_model=InvoiceResponse)
def update_invoice_status(
    invoice_id: UUID,
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
    ).with_for_update().first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    try:
        updated = transition_invoice(invoice, payload.status, db)
    except HTTPException:
        db.rollback()
        raise

    return _invoice_to_response(updated, db)


@router.post(
    "/{invoice_id}/payments",
    response_model=InvoiceResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_invoice_payment(
    invoice_id: UUID,
    payload: InvoicePaymentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record a cash/card/etc. payment. Partial payments move the invoice to
    partially_paid; the payment that clears the balance moves it to paid.
    Overpayment is rejected."""
    invoice = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.user_id == current_user.id,
    ).with_for_update().first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    try:
        record_invoice_payment(
            invoice,
            payload.amount,
            payload.method,
            db,
            note=payload.note,
            client_request_id=payload.client_request_id,
        )
    except HTTPException:
        db.rollback()
        raise
    db.refresh(invoice)
    return _invoice_to_response(invoice, db)


@router.post("/{invoice_id}/pay")
def create_invoice_payment(
    invoice_id: UUID,
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
    if invoice.amount_paid and invoice.amount_paid > 0:
        # A Stripe intent is for the full total; it can't settle a balance.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This invoice already has payments. Record the rest as a payment instead.",
        )

    return create_payment_intent(db, invoice, current_user)


@router.get("/{invoice_id}/pdf")
def export_invoice_pdf(
    invoice_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate a styled PDF invoice and return it as a base64 string.

    Response: { pdf_base64: str, filename: str }
    """
    invoice = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.user_id == current_user.id,
    ).first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    items = db.query(InvoiceItem).filter(InvoiceItem.invoice_id == invoice.id).all()

    inv_number = invoice.invoice_number

    pdf_bytes = generate_invoice_pdf(invoice, items, current_user, inv_number)
    pdf_b64 = base64.b64encode(pdf_bytes).decode("utf-8")

    return {"pdf_base64": pdf_b64, "filename": f"invoice-{inv_number}.pdf"}
