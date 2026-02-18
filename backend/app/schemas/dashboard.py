"""Dashboard Pydantic schemas — aggregated business metrics."""
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel


class DashboardResponse(BaseModel):
    """Dashboard v1 — Sprint 2 metrics."""
    # Revenue
    revenue_today: Decimal
    revenue_week: Decimal
    revenue_month: Decimal

    # Profit
    net_profit_today: Decimal
    net_profit_week: Decimal
    net_profit_month: Decimal
    net_profit_all_time: Decimal

    # Inventory value
    total_inventory_value: Decimal  # sum of buy_price for active items
    total_expected_value: Decimal   # sum of expected_sell_price for active items
    potential_profit: Decimal       # expected_value - inventory_value

    # Counts
    total_items: int
    items_in_stock: int
    items_listed: int
    items_sold: int

    # Transactions
    total_transactions: int
    total_refunds: int
