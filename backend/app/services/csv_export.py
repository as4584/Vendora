"""CSV export service — canonical worksheet format.

Export columns match the spreadsheet import template so merchants can
round-trip: export → edit → re-import without column remapping.
"""
import csv
import io

from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem
from app.models.transaction import Transaction


# Canonical worksheet column order for inventory export / import template.
# Changing this list is a breaking change — keep in sync with IMPORT_HEADER_MAP
# in services/inventory_import.py.
INVENTORY_EXPORT_COLUMNS = [
    "id", "name", "category", "sku", "upc", "size", "color", "condition",
    "quantity", "buy_price", "expected_sell_price", "actual_sell_price",
    "status", "platform", "vendor_name", "notes",
    "photo_front_url", "photo_back_url", "front_image_formula", "back_image_formula",
    "size_breakdown",
    "source", "external_id",
    "created_at", "updated_at",
]


def _resolved_photo(item: InventoryItem, key: str) -> str:
    """Prefer dedicated photo columns, fallback to legacy custom_attributes storage."""
    direct_value = getattr(item, f"{key}_url", None)
    if direct_value:
        return direct_value

    attrs = item.custom_attributes or {}
    legacy_value = attrs.get(key)
    return legacy_value or ""


def _image_formula(url: str) -> str:
    if not url:
        return ""
    escaped = url.replace('"', '""')
    return f'=IMAGE("{escaped}")'


def _size_breakdown(item: InventoryItem) -> str:
    attrs = item.custom_attributes or {}
    variants = attrs.get("variants")
    if isinstance(variants, list) and variants:
        parts: list[str] = []
        for variant in variants:
            if not isinstance(variant, dict):
                continue
            size = str(variant.get("size") or "").strip()
            quantity = variant.get("quantity")
            if not size:
                continue
            try:
                qty_int = int(quantity)
            except (TypeError, ValueError):
                qty_int = 0
            parts.append(f"{size} ({qty_int})")
        if parts:
            return "; ".join(parts)

    if item.size:
        return f"{item.size} ({item.quantity})"
    return ""


def export_inventory_csv(db: Session, user_id) -> str:
    """Export all active inventory items as a canonical worksheet CSV.

    The header row matches the import template so the file can be
    edited and re-imported without remapping columns.
    """
    items = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user_id,
            InventoryItem.deleted_at.is_(None),
        )
        .order_by(InventoryItem.created_at.desc())
        .all()
    )

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow(INVENTORY_EXPORT_COLUMNS)

    for item in items:
        photo_front_url = _resolved_photo(item, "photo_front")
        photo_back_url = _resolved_photo(item, "photo_back")
        writer.writerow([
            str(item.id),
            item.name,
            item.category or "",
            item.sku or "",
            item.upc or "",
            item.size or "",
            item.color or "",
            item.condition or "",
            item.quantity,
            str(item.buy_price) if item.buy_price is not None else "",
            str(item.expected_sell_price) if item.expected_sell_price is not None else "",
            str(item.actual_sell_price) if item.actual_sell_price is not None else "",
            item.status,
            item.platform or "",
            item.vendor_name or "",
            item.notes or "",
            photo_front_url,
            photo_back_url,
            _image_formula(photo_front_url),
            _image_formula(photo_back_url),
            _size_breakdown(item),
            item.source or "",
            item.external_id or "",
            item.created_at.isoformat() if item.created_at else "",
            item.updated_at.isoformat() if item.updated_at else "",
        ])

    return output.getvalue()


def export_transactions_csv(db: Session, user_id) -> str:
    """Export all transactions as CSV string."""
    txns = (
        db.query(Transaction)
        .filter(Transaction.user_id == user_id)
        .order_by(Transaction.created_at.desc())
        .all()
    )

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow([
        "Date", "Method", "Status", "Gross Amount", "Fee",
        "Net Amount", "Quantity", "Is Refund", "Invoice ID", "Item ID", "Notes",
    ])

    for txn in txns:
        writer.writerow([
            txn.created_at.isoformat() if txn.created_at else "",
            txn.method,
            txn.status,
            str(txn.gross_amount),
            str(txn.fee_amount),
            str(txn.net_amount),
            txn.quantity,
            "Yes" if txn.is_refund else "No",
            str(txn.invoice_id) if txn.invoice_id else "",
            str(txn.item_id) if txn.item_id else "",
            txn.notes or "",
        ])

    return output.getvalue()
