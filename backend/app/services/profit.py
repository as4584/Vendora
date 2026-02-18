"""Profit Calculation Engine — isolated service (Sprint 2).

Per ARCHITECTURE.md:
    net_profit = gross_amount - fee_amount - shipping - tax - buy_price

Must run on:
    - Transaction creation
    - Webhook
    - Manual entry

This is Core Engine code — 100% test coverage required.
"""
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy import func, and_, case
from sqlalchemy.orm import Session

from app.models.transaction import Transaction
from app.models.inventory import InventoryItem


def calculate_net_amount(
    gross_amount: Decimal,
    fee_amount: Decimal = Decimal("0.00"),
) -> Decimal:
    """Calculate net amount from gross minus fees.

    This is the core profit calculation — must be deterministic.
    """
    return Decimal(str(gross_amount)) - Decimal(str(fee_amount))


def calculate_item_profit(
    actual_sell_price: Decimal,
    buy_price: Decimal,
    fee_amount: Decimal = Decimal("0.00"),
) -> Decimal:
    """Calculate profit for a single item sale.

    profit = actual_sell_price - buy_price - fee_amount
    """
    return (
        Decimal(str(actual_sell_price))
        - Decimal(str(buy_price))
        - Decimal(str(fee_amount))
    )


def get_revenue(db: Session, user_id, since: Optional[datetime] = None) -> Decimal:
    """Sum of gross_amount for all non-refund transactions (completed or refunded).

    Includes transactions whose status is 'refunded' because the sale originally
    happened — the refund is tracked separately via get_refund_total.
    """
    query = db.query(func.coalesce(func.sum(Transaction.gross_amount), Decimal("0.00"))).filter(
        Transaction.user_id == user_id,
        Transaction.status.in_(["completed", "refunded"]),
        Transaction.is_refund == False,
    )
    if since:
        query = query.filter(Transaction.created_at >= since)
    return query.scalar() or Decimal("0.00")


def get_refund_total(db: Session, user_id, since: Optional[datetime] = None) -> Decimal:
    """Sum of gross_amount for refund transactions (positive number)."""
    query = db.query(func.coalesce(func.sum(Transaction.gross_amount), Decimal("0.00"))).filter(
        Transaction.user_id == user_id,
        Transaction.is_refund == True,
    )
    if since:
        query = query.filter(Transaction.created_at >= since)
    return query.scalar() or Decimal("0.00")


def get_net_profit(db: Session, user_id, since: Optional[datetime] = None) -> Decimal:
    """Net profit = revenue - refunds - total fees.

    This accounts for both sales and refunds.
    """
    # Sum net_amount for completed sales (positive)
    sales_query = db.query(
        func.coalesce(func.sum(Transaction.net_amount), Decimal("0.00"))
    ).filter(
        Transaction.user_id == user_id,
        Transaction.status.in_(["completed", "refunded"]),
        Transaction.is_refund == False,
    )
    if since:
        sales_query = sales_query.filter(Transaction.created_at >= since)
    sales_net = sales_query.scalar() or Decimal("0.00")

    # Sum net_amount for refunds (negative values)
    refund_query = db.query(
        func.coalesce(func.sum(Transaction.net_amount), Decimal("0.00"))
    ).filter(
        Transaction.user_id == user_id,
        Transaction.is_refund == True,
    )
    if since:
        refund_query = refund_query.filter(Transaction.created_at >= since)
    refund_net = refund_query.scalar() or Decimal("0.00")

    # Get total buy_price for sold items (cost basis)
    cost_query = db.query(
        func.coalesce(func.sum(InventoryItem.buy_price), Decimal("0.00"))
    ).filter(
        InventoryItem.user_id == user_id,
        InventoryItem.status.in_(["sold", "shipped", "paid", "archived"]),
        InventoryItem.deleted_at.is_(None),
        InventoryItem.buy_price.isnot(None),
    )
    if since:
        cost_query = cost_query.filter(InventoryItem.updated_at >= since)
    cost_basis = cost_query.scalar() or Decimal("0.00")

    return sales_net + refund_net - cost_basis


def get_inventory_value(db: Session, user_id) -> dict:
    """Calculate total inventory value and expected value for active items."""
    result = db.query(
        func.coalesce(func.sum(
            case((InventoryItem.buy_price.isnot(None), InventoryItem.buy_price), else_=Decimal("0.00"))
        ), Decimal("0.00")).label("total_cost"),
        func.coalesce(func.sum(
            case((InventoryItem.expected_sell_price.isnot(None), InventoryItem.expected_sell_price), else_=Decimal("0.00"))
        ), Decimal("0.00")).label("total_expected"),
    ).filter(
        InventoryItem.user_id == user_id,
        InventoryItem.status.in_(["in_stock", "listed"]),
        InventoryItem.deleted_at.is_(None),
    ).first()

    total_cost = result.total_cost if result else Decimal("0.00")
    total_expected = result.total_expected if result else Decimal("0.00")

    return {
        "total_inventory_value": total_cost,
        "total_expected_value": total_expected,
        "potential_profit": total_expected - total_cost,
    }


def get_item_counts(db: Session, user_id) -> dict:
    """Get inventory item counts by status."""
    results = db.query(
        InventoryItem.status,
        func.count(InventoryItem.id),
    ).filter(
        InventoryItem.user_id == user_id,
        InventoryItem.deleted_at.is_(None),
    ).group_by(InventoryItem.status).all()

    counts = {status: count for status, count in results}
    return {
        "total_items": sum(counts.values()),
        "items_in_stock": counts.get("in_stock", 0),
        "items_listed": counts.get("listed", 0),
        "items_sold": counts.get("sold", 0) + counts.get("shipped", 0) + counts.get("paid", 0),
    }


def get_transaction_counts(db: Session, user_id) -> dict:
    """Get transaction counts."""
    total = db.query(func.count(Transaction.id)).filter(
        Transaction.user_id == user_id,
        Transaction.is_refund == False,
    ).scalar() or 0

    refunds = db.query(func.count(Transaction.id)).filter(
        Transaction.user_id == user_id,
        Transaction.is_refund == True,
    ).scalar() or 0

    return {"total_transactions": total, "total_refunds": refunds}
