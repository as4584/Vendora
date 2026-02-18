"""CSV export service — Sprint 4.

Export inventory items and transactions as CSV for Pro users.
"""
import csv
import io
from datetime import datetime

from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem
from app.models.transaction import Transaction


def export_inventory_csv(db: Session, user_id) -> str:
    """Export all active inventory items as CSV string."""
    items = db.query(InventoryItem).filter(
        InventoryItem.user_id == user_id,
        InventoryItem.deleted_at.is_(None),
    ).order_by(InventoryItem.created_at.desc()).all()

    output = io.StringIO()
    writer = csv.writer(output)

    # Header
    writer.writerow([
        "Name", "Category", "SKU", "UPC", "Size", "Color", "Condition",
        "Buy Price", "Expected Sell Price", "Actual Sell Price",
        "Status", "Platform", "Created At",
    ])

    for item in items:
        writer.writerow([
            item.name,
            item.category or "",
            item.sku or "",
            item.upc or "",
            item.size or "",
            item.color or "",
            item.condition or "",
            str(item.buy_price) if item.buy_price else "",
            str(item.expected_sell_price) if item.expected_sell_price else "",
            str(item.actual_sell_price) if item.actual_sell_price else "",
            item.status,
            item.platform or "",
            item.created_at.isoformat() if item.created_at else "",
        ])

    return output.getvalue()


def export_transactions_csv(db: Session, user_id) -> str:
    """Export all transactions as CSV string."""
    txns = db.query(Transaction).filter(
        Transaction.user_id == user_id,
    ).order_by(Transaction.created_at.desc()).all()

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow([
        "Date", "Method", "Status", "Gross Amount", "Fee",
        "Net Amount", "Is Refund", "Notes",
    ])

    for txn in txns:
        writer.writerow([
            txn.created_at.isoformat() if txn.created_at else "",
            txn.method,
            txn.status,
            str(txn.gross_amount),
            str(txn.fee_amount),
            str(txn.net_amount),
            "Yes" if txn.is_refund else "No",
            txn.notes or "",
        ])

    return output.getvalue()
