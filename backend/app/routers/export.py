"""Export router — CSV export endpoints (Pro only).

Endpoints:
    GET /api/v1/export/inventory  — Download inventory CSV
    GET /api/v1/export/transactions — Download transactions CSV
"""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
import io

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.services.feature_flags import is_feature_enabled
from app.services.csv_export import export_inventory_csv, export_transactions_csv

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
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download inventory as CSV file (Pro only)."""
    _require_pro(current_user)

    csv_content = export_inventory_csv(db, current_user.id)

    return StreamingResponse(
        io.BytesIO(csv_content.encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=vendora_inventory.csv"},
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
