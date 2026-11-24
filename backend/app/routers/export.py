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
                "message": "CSV export requires Pro.",
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
            headers={"Content-Disposition": "attachment; filename=resqlo_inventory.xlsx"},
        )

    if template == "warehouse":
        csv_content = export_inventory_warehouse_csv(db, current_user.id)
        filename = "resqlo_inventory_warehouse.csv"
    else:
        csv_content = export_inventory_csv(db, current_user.id)
        filename = "resqlo_inventory.csv"

    return StreamingResponse(
        io.BytesIO(csv_content.encode("utf-8-sig")),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


def _tax_year(year: int | None) -> int:
    from datetime import datetime, timezone

    this_year = datetime.now(timezone.utc).year
    year = year or this_year
    if not 2000 <= year <= this_year:
        raise HTTPException(status_code=400, detail="Pick a year up to this one.")
    return year


@router.get("/tax-summary")
def tax_summary(
    year: int | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Year-end profit and loss, by month and channel (Pro only)."""
    from app.services.tax_pack import build_tax_summary

    _require_pro(current_user)
    from decimal import Decimal

    def exact(value):
        # Money as exact 2-decimal strings, never floats.
        if isinstance(value, Decimal):
            return str(value.quantize(Decimal("0.01")))
        if isinstance(value, dict):
            return {k: exact(v) for k, v in value.items()}
        if isinstance(value, list):
            return [exact(v) for v in value]
        return value

    return exact(build_tax_summary(db, current_user.id, _tax_year(year)))


@router.get("/tax-pack")
def tax_pack_csv(
    year: int | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download the year's tax pack as CSV for an accountant (Pro only)."""
    from app.services.tax_pack import build_tax_csv

    _require_pro(current_user)
    year = _tax_year(year)
    return StreamingResponse(
        io.BytesIO(build_tax_csv(db, current_user.id, year).encode("utf-8-sig")),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=resqlo_tax_pack_{year}.csv"},
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
        io.BytesIO(csv_content.encode("utf-8-sig")),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=resqlo_transactions.csv"},
    )
