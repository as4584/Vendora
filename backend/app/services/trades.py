"""Trades: swap pairs (plus cash either way) in one atomic write.

Accounting
----------
- Each pair given is a sale at its agreed value: a Transaction with method
  "trade", fee 0, cost frozen from its buy price, sharing one order_id.
- What I got paid for those pairs = the pairs received + cash received.
  So the pairs received cost me ``value_out - cash_amount`` in total, split
  across them by their agreed values. That is their buy price (cost basis),
  so profit is counted once, when they are later sold.
- A cash-only buy (nothing given, I pay cash) is a trade with ``give=[]``:
  the received pairs cost exactly the cash paid.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem
from app.models.transaction import OrderPayment, Trade, Transaction
from app.schemas.trade import TradeCreate, TradeResponse
from app.services.checkout import allocate, cents
from app.services.customers import get_owned_customer
from app.services.inventory import deduct_stock, get_available_quantity
from app.services.invoice import _deduct_variant_quantity, _variant_rows, check_invoice_item_availability

ZERO = Decimal("0.00")


def _bad(message: str, code: str = "trade_unbalanced") -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail={"error": code, "message": message})


def cost_basis(payload: TradeCreate) -> tuple[Decimal, Decimal, list[Decimal]]:
    """(value_out, value_in_basis, per-received-pair basis). Raises 422 if it can't balance."""
    value_out = cents(sum((g.value * g.quantity for g in payload.give), ZERO))
    basis_total = value_out - cents(payload.cash_amount)
    if not payload.get:
        if basis_total != ZERO:
            raise _bad("Nothing received, so the cash must equal the value of the pairs given.")
        return value_out, ZERO, []
    if basis_total < ZERO:
        raise _bad("Cash received is more than the pairs given are worth.")
    weights = [g.value for g in payload.get]
    if sum(weights, ZERO) == ZERO:
        weights = [Decimal(1)] * len(payload.get)  # no values entered: split evenly
    return value_out, basis_total, allocate(basis_total, weights)


def _response(db: Session, trade: Trade) -> TradeResponse:
    txns = db.query(Transaction).filter(Transaction.order_id == trade.order_id, Transaction.user_id == trade.user_id).all()
    costs = [t.cost_amount for t in txns]
    profit = None if any(c is None for c in costs) else cents(sum((t.gross_amount for t in txns), ZERO) - sum(costs, ZERO))
    return TradeResponse(
        id=trade.id, order_id=trade.order_id, value_out=trade.value_out, value_in=trade.value_in,
        cash_amount=trade.cash_amount, cash_method=trade.cash_method, profit=profit,
        transaction_ids=[t.id for t in txns],
        received_item_ids=[uuid.UUID(i) for i in trade.received_item_ids or []],
        created_at=trade.created_at,
    )


def _replayed(db: Session, user_id, request_id: str | None) -> TradeResponse | None:
    if not request_id:
        return None
    trade = db.query(Trade).filter(Trade.user_id == user_id, Trade.client_request_id == request_id).first()
    return _response(db, trade) if trade else None


def record_trade(db: Session, user_id, payload: TradeCreate) -> TradeResponse:
    replay = _replayed(db, user_id, payload.client_request_id)
    if replay:
        return replay
    value_out, value_in, bases = cost_basis(payload)

    ids = {g.item_id for g in payload.give}
    items = {
        i.id: i for i in db.query(InventoryItem).filter(
            InventoryItem.id.in_(ids), InventoryItem.user_id == user_id, InventoryItem.deleted_at.is_(None),
        ).order_by(InventoryItem.id).with_for_update().all()
    } if ids else {}
    wanted: dict = {}
    for g in payload.give:
        if g.item_id not in items:
            raise HTTPException(status_code=404, detail=f"Item {g.item_id} not found")
        wanted[g.item_id] = wanted.get(g.item_id, 0) + g.quantity
        if g.size and _variant_rows(items[g.item_id]):
            check_invoice_item_availability(items[g.item_id], g.quantity, g.size)
    for item_id, qty in wanted.items():
        available = get_available_quantity(items[item_id])
        if available < qty:
            raise HTTPException(status_code=409, detail={
                "error": "insufficient_stock", "item_id": str(item_id), "available": available, "requested": qty,
                "message": f"Only {available} unit(s) of {items[item_id].name} available.",
            })
    customer = get_owned_customer(db, user_id, payload.customer_id) if payload.customer_id else None

    order_id = uuid.uuid4()
    try:
        for index, g in enumerate(payload.give):
            item = items[g.item_id]
            gross = cents(g.value * g.quantity)
            size = g.size.strip() if g.size else None
            txn = Transaction(
                user_id=user_id, item_id=item.id, customer_id=customer.id if customer else None,
                order_id=order_id, method="trade", status="completed",
                gross_amount=gross, fee_amount=ZERO, net_amount=gross,
                quantity=g.quantity, variant_size=size, notes=payload.notes or "Trade",
                source="app" if payload.client_request_id else None,
                external_reference_id=f"{payload.client_request_id}:t{index}" if payload.client_request_id else None,
            )
            db.add(txn)
            db.flush()
            item.actual_sell_price = g.value
            if size and _variant_rows(item):
                _deduct_variant_quantity(item, size, g.quantity)
            deduct_stock(db, item, quantity=g.quantity, event_type="sale", source_type="trade",
                         source_id=str(txn.id), idempotency_key=f"txn:{txn.id}:trade")

        received: list[str] = []
        for g, basis in zip(payload.get, bases):
            new = InventoryItem(
                user_id=user_id, name=g.name.strip(), size=g.size, upc=g.upc, sku=g.sku,
                category=g.category or "Sneakers", condition=g.condition,
                buy_price=basis, expected_sell_price=g.list_price if g.list_price is not None else g.value,
                quantity=1, status="in_stock", source="trade", vendor_name=customer.name if customer else None,
                custom_attributes={"trade_order_id": str(order_id), "trade_value": str(g.value)},
            )
            db.add(new)
            db.flush()
            received.append(str(new.id))

        if payload.cash_amount > ZERO:
            db.add(OrderPayment(user_id=user_id, order_id=order_id, method=payload.cash_method, amount=payload.cash_amount))
        trade = Trade(
            user_id=user_id, order_id=order_id, customer_id=customer.id if customer else None,
            cash_amount=cents(payload.cash_amount), cash_method=payload.cash_method if payload.cash_amount else None,
            value_out=value_out, value_in=value_in, received_item_ids=received,
            notes=payload.notes, client_request_id=payload.client_request_id,
        )
        db.add(trade)
        db.commit()
    except Exception:
        db.rollback()
        replay = _replayed(db, user_id, payload.client_request_id)
        if replay:
            return replay
        raise
    db.refresh(trade)
    return _response(db, trade)


def list_trades(db: Session, user_id, limit: int = 50) -> list[TradeResponse]:
    trades = db.query(Trade).filter(Trade.user_id == user_id).order_by(Trade.created_at.desc()).limit(limit).all()
    return [_response(db, t) for t in trades]
