"""End-of-show summary ("close out the show") computed from transactions.

Money definitions (see app.services.checkout):
    subtotal  = what items were rung up at, before the order discount
    discounts = order discounts given
    net_sales = subtotal - discounts            (revenue, excludes tax)
    tax       = sales tax collected (owed to the state, never profit)
    refunds   = revenue given back on refunds   (tax refunded is tracked apart)
    fees      = processing fees on sales        (not returned on refunds)
    cost      = cost of goods sold, net of refunded units going back to stock
    profit    = net_sales - refunds - fees - cost
    collected = net_sales + tax - refunds - refunded tax   (money taken in)

Payment breakdown: for orders with payment parts (order_payments), each part
counts under its own method, so a $200 cash + $85 card order puts $200 in the
cash box. Older/single sales count under the transaction's method. Refunds are
subtracted from the method they were paid with ("split" when the refunded line
came from a split-payment order, since the app can't know which part was
handed back).
"""
from collections import defaultdict
from datetime import datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem
from app.models.transaction import OrderPayment, Transaction

ZERO = Decimal("0.00")


def _d(value) -> Decimal:
    return Decimal(value) if value is not None else ZERO


def build_show_summary(db: Session, user_id, since: datetime, until: datetime) -> dict:
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.user_id == user_id,
            Transaction.created_at >= since,
            Transaction.created_at <= until,
            Transaction.status.in_(["completed", "refunded"]),
        )
        .all()
    )
    sales = [t for t in txns if not t.is_refund]
    refunds = [t for t in txns if t.is_refund]

    subtotal = sum((_d(t.gross_amount) + _d(t.discount_amount) for t in sales), ZERO)
    discounts = sum((_d(t.discount_amount) for t in sales), ZERO)
    net_sales = sum((_d(t.gross_amount) for t in sales), ZERO)
    tax = sum((_d(t.tax_amount) for t in sales), ZERO)
    fees = sum((_d(t.fee_amount) for t in sales), ZERO)
    refund_amount = sum((_d(t.gross_amount) for t in refunds), ZERO)
    refund_tax = sum((_d(t.tax_amount) for t in refunds), ZERO)
    # Refunds carry the negative of the original cost (the unit is restocked).
    cost = sum((_d(t.cost_amount) for t in txns), ZERO)
    missing_cost = sum(1 for t in sales if t.cost_amount is None and t.item_id is not None)
    profit = net_sales - refund_amount - fees - cost

    order_ids = {t.order_id for t in sales if t.order_id}
    parts_by_order: dict = defaultdict(list)
    if order_ids:
        for part in (
            db.query(OrderPayment)
            .filter(OrderPayment.user_id == user_id, OrderPayment.order_id.in_(order_ids))
            .all()
        ):
            parts_by_order[part.order_id].append(part)

    by_method: dict = defaultdict(lambda: {"collected": ZERO, "refunded": ZERO, "count": 0})
    seen_orders = set()
    for t in sales:
        if t.order_id and t.order_id in parts_by_order:
            if t.order_id in seen_orders:
                continue
            seen_orders.add(t.order_id)
            for part in parts_by_order[t.order_id]:
                by_method[part.method]["collected"] += _d(part.amount)
                by_method[part.method]["count"] += 1
        else:
            by_method[t.method]["collected"] += _d(t.gross_amount) + _d(t.tax_amount)
            by_method[t.method]["count"] += 1
    for t in refunds:
        by_method[t.method]["refunded"] += _d(t.gross_amount) + _d(t.tax_amount)

    payments = sorted(
        (
            {
                "method": method,
                "collected": v["collected"],
                "refunded": v["refunded"],
                "net": v["collected"] - v["refunded"],
                "count": v["count"],
            }
            for method, v in by_method.items()
        ),
        key=lambda row: (-row["net"], row["method"]),
    )

    per_item: dict = defaultdict(lambda: {"units": 0, "revenue": ZERO})
    for t in sales:
        if t.item_id is None:
            continue
        per_item[t.item_id]["units"] += t.quantity or 1
        per_item[t.item_id]["revenue"] += _d(t.gross_amount)
    names = {}
    if per_item:
        names = dict(
            db.query(InventoryItem.id, InventoryItem.name)
            .filter(InventoryItem.id.in_(list(per_item)))
            .all()
        )
    top_items = sorted(
        (
            {"item_id": item_id, "name": names.get(item_id) or "Deleted item", **v}
            for item_id, v in per_item.items()
        ),
        key=lambda row: (-row["revenue"], -row["units"], row["name"]),
    )[:5]

    orders = len(order_ids) + sum(1 for t in sales if not t.order_id)
    return {
        "since": since,
        "until": until,
        "orders": orders,
        "units_sold": sum((t.quantity or 1) for t in sales),
        "units_refunded": sum((t.quantity or 1) for t in refunds),
        "subtotal": subtotal,
        "discounts": discounts,
        "net_sales": net_sales,
        "tax_collected": tax,
        "fees": fees,
        "refunds": refund_amount,
        "refunded_tax": refund_tax,
        "refund_count": len(refunds),
        "cost_of_goods": cost,
        "sales_missing_cost": missing_cost,
        "profit": profit,
        "collected": net_sales + tax - refund_amount - refund_tax,
        "payments": payments,
        "top_items": top_items,
    }
