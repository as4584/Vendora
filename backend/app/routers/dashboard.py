"""Dashboard router — /api/v1/dashboard

Provides aggregated business metrics per ROADMAP Sprint 2:
    Revenue today, net profit, inventory value.
"""
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.schemas.dashboard import DashboardResponse
from app.services.profit import (
    get_revenue,
    get_refund_total,
    get_net_profit,
    get_inventory_value,
    get_item_counts,
    get_transaction_counts,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("", response_model=DashboardResponse)
def get_dashboard(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return all dashboard metrics for the current user."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=today_start.weekday())
    month_start = today_start.replace(day=1)

    uid = current_user.id

    # Revenue (gross sales - refunds)
    rev_today = get_revenue(db, uid, since=today_start) - get_refund_total(db, uid, since=today_start)
    rev_week = get_revenue(db, uid, since=week_start) - get_refund_total(db, uid, since=week_start)
    rev_month = get_revenue(db, uid, since=month_start) - get_refund_total(db, uid, since=month_start)

    # Net profit
    profit_today = get_net_profit(db, uid, since=today_start)
    profit_week = get_net_profit(db, uid, since=week_start)
    profit_month = get_net_profit(db, uid, since=month_start)
    profit_all = get_net_profit(db, uid)

    # Inventory
    inv = get_inventory_value(db, uid)
    counts = get_item_counts(db, uid)
    txn_counts = get_transaction_counts(db, uid)

    return DashboardResponse(
        revenue_today=rev_today,
        revenue_week=rev_week,
        revenue_month=rev_month,
        net_profit_today=profit_today,
        net_profit_week=profit_week,
        net_profit_month=profit_month,
        net_profit_all_time=profit_all,
        total_inventory_value=inv["total_inventory_value"],
        total_expected_value=inv["total_expected_value"],
        potential_profit=inv["potential_profit"],
        total_items=counts["total_items"],
        items_in_stock=counts["items_in_stock"],
        items_listed=counts["items_listed"],
        items_sold=counts["items_sold"],
        total_transactions=txn_counts["total_transactions"],
        total_refunds=txn_counts["total_refunds"],
    )
