"""Export router — CSV export endpoints (Pro only).

Endpoints:
    GET /api/v1/export/inventory  — Download inventory CSV
    GET /api/v1/export/transactions — Download transactions CSV
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
import io

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.services.feature_flags import is_feature_enabled
from app.services.csv_export import (
    export_inventory_csv,
    export_inventory_warehouse_csv,
    export_transactions_csv,
)
from app.services.xlsx_export import export_inventory_xlsx

_XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

router = APIRouter(prefix="/export", tags=["export"])


def _require_pro(user: User):
    """Gate export features behind Pro tier."""
    if not is_feature_enabled("csv_export", user.subscription_tier):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "pro_required",
                "message": "CSV export requires Pro tier ($20/mo).",
                "feature": "csv_export",
            },
        )


@router.get("/inventory")
def export_inventory(
    template: str = Query("canonical", pattern="^(canonical|warehouse)$"),
    format: str = Query("csv", pattern="^(csv|xlsx)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download inventory (Pro only).

    format=xlsx → a styled .xlsx with item photos **embedded as real images**
    (base64 data URLs can't render via =IMAGE, so CSV showed them as text).
    format=csv  → the round-trip-friendly CSV template.
    """
    _require_pro(current_user)

    if format == "xlsx":
        xlsx_bytes = export_inventory_xlsx(db, current_user.id)
        return StreamingResponse(
            io.BytesIO(xlsx_bytes),
            media_type=_XLSX_MEDIA,
            headers={"Content-Disposition": "attachment; filename=vendora_inventory.xlsx"},
        )

    if template == "warehouse":
        csv_content = export_inventory_warehouse_csv(db, current_user.id)
        filename = "vendora_inventory_warehouse.csv"
    else:
        csv_content = export_inventory_csv(db, current_user.id)
        filename = "vendora_inventory.csv"

    return StreamingResponse(
        io.BytesIO(csv_content.encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/transactions")
def export_transactions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download transactions as CSV file (Pro only)."""
    _require_pro(current_user)

    csv_content = export_transactions_csv(db, current_user.id)

    return StreamingResponse(
        io.BytesIO(csv_content.encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=vendora_transactions.csv"},
    )
