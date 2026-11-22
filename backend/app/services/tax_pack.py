"""Year-end tax pack: profit and loss for one calendar year, by month and by
sales channel, plus every sale line, as JSON (for the app) and CSV (for an
accountant).

Channels come from ``Transaction.source`` (the integration that imported the
sale, e.g. "ebay"); sales logged in Resqlo are "in_app". Figures follow the
dashboard's profit rules: refunds subtract, cost of goods is frozen on each
sale, and sales with unknown cost are counted so the gap is visible.
"""
from __future__ import annotations

import csv
import io
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem
from app.models.transaction import Transaction

ZERO = Decimal("0.00")
CHANNEL_LABELS = {"in_app": "Logged in Resqlo", "ebay": "eBay", "stockx": "StockX", "square": "Square",
                  "clover": "Clover", "lightspeed": "Lightspeed", "invoice": "Invoices"}


def _year_bounds(year: int) -> tuple[datetime, datetime]:
    return datetime(year, 1, 1, tzinfo=timezone.utc), datetime(year + 1, 1, 1, tzinfo=timezone.utc)


def _year_rows(db: Session, user_id: uuid.UUID, year: int) -> list[Transaction]:
    start, end = _year_bounds(year)
    return (
        db.query(Transaction)
        .filter(
            Transaction.user_id == user_id,
            Transaction.created_at >= start,
            Transaction.created_at < end,
            or_(Transaction.is_refund.is_(True), Transaction.status.in_(["completed", "refunded"])),
        )
        .order_by(Transaction.created_at.asc())
        .all()
    )


def _bucket() -> dict:
    return {"gross_sales": ZERO, "refunds": ZERO, "fees": ZERO, "cost_of_goods": ZERO, "net_profit": ZERO, "sales_count": 0}


def _add(b: dict, t: Transaction) -> None:
    cost = t.cost_amount or ZERO
    if t.is_refund:
        b["refunds"] += abs(t.gross_amount or ZERO)
        b["net_profit"] += (t.net_amount or ZERO) - cost
    else:
        b["gross_sales"] += t.gross_amount or ZERO
        b["fees"] += t.fee_amount or ZERO
        b["net_profit"] += (t.net_amount or ZERO) - cost
        b["sales_count"] += 1
    b["cost_of_goods"] += cost


def build_tax_summary(db: Session, user_id: uuid.UUID, year: int) -> dict:
    rows = _year_rows(db, user_id, year)
    total = _bucket()
    months = {m: _bucket() for m in range(1, 13)}
    channels: dict[str, dict] = defaultdict(_bucket)
    missing_cost = 0
    for t in rows:
        _add(total, t)
        _add(months[t.created_at.month], t)
        _add(channels[t.source or "in_app"], t)
        if not t.is_refund and t.cost_amount is None:
            missing_cost += 1
    return {
        "year": year,
        **total,
        "sales_missing_cost": missing_cost,
        "by_month": [{"month": m, **months[m]} for m in range(1, 13)],
        "by_channel": sorted(
            ({"channel": c, "label": CHANNEL_LABELS.get(c, c.title()), **b} for c, b in channels.items()),
            key=lambda r: r["gross_sales"], reverse=True,
        ),
    }


def _money(v: Decimal) -> str:
    return f"{Decimal(v).quantize(Decimal('0.01'))}"


def build_tax_csv(db: Session, user_id: uuid.UUID, year: int) -> str:
    s = build_tax_summary(db, user_id, year)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow([f"Resqlo tax pack {year}"])
    w.writerow(["Generated", datetime.now(timezone.utc).strftime("%Y-%m-%d")])
    w.writerow([])
    w.writerow(["Summary"])
    for key, label in (("gross_sales", "Gross sales"), ("refunds", "Refunds"), ("fees", "Marketplace & payment fees"),
                       ("cost_of_goods", "Cost of goods sold"), ("net_profit", "Net profit")):
        w.writerow([label, _money(s[key])])
    w.writerow(["Sales", s["sales_count"]])
    w.writerow(["Sales with no cost recorded", s["sales_missing_cost"]])
    w.writerow([])
    w.writerow(["By channel (compare with each platform's 1099-K)"])
    w.writerow(["Channel", "Gross sales", "Refunds", "Fees", "Cost of goods", "Net profit", "Sales"])
    for c in s["by_channel"]:
        w.writerow([c["label"], _money(c["gross_sales"]), _money(c["refunds"]), _money(c["fees"]),
                    _money(c["cost_of_goods"]), _money(c["net_profit"]), c["sales_count"]])
    w.writerow([])
    w.writerow(["By month"])
    w.writerow(["Month", "Gross sales", "Refunds", "Fees", "Cost of goods", "Net profit", "Sales"])
    for m in s["by_month"]:
        w.writerow([f"{year}-{m['month']:02d}", _money(m["gross_sales"]), _money(m["refunds"]), _money(m["fees"]),
                    _money(m["cost_of_goods"]), _money(m["net_profit"]), m["sales_count"]])
    w.writerow([])
    w.writerow(["Sales"])
    w.writerow(["Date", "Item", "Channel", "Type", "Quantity", "Gross", "Fees", "Net", "Cost of goods", "Reference"])
    rows = _year_rows(db, user_id, year)
    names = dict(
        db.query(InventoryItem.id, InventoryItem.name)
        .filter(InventoryItem.id.in_({t.item_id for t in rows if t.item_id}))
        .all()
    ) if rows else {}
    for t in rows:
        w.writerow([
            t.created_at.strftime("%Y-%m-%d"), names.get(t.item_id, ""),
            CHANNEL_LABELS.get(t.source or "in_app", (t.source or "").title()),
            "Refund" if t.is_refund else "Sale", t.quantity, _money(t.gross_amount or ZERO),
            _money(t.fee_amount or ZERO), _money(t.net_amount or ZERO),
            "" if t.cost_amount is None else _money(t.cost_amount), t.external_reference_id or "",
        ])
    return out.getvalue()
