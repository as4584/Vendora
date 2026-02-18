"""Profit engine unit tests — 100% coverage required.

Tests the isolated profit calculation functions directly,
without going through API endpoints.
"""
from decimal import Decimal

import pytest

from app.services.profit import (
    calculate_net_amount,
    calculate_item_profit,
)


class TestCalculateNetAmount:
    def test_no_fees(self):
        assert calculate_net_amount(Decimal("100.00")) == Decimal("100.00")

    def test_with_fees(self):
        assert calculate_net_amount(Decimal("100.00"), Decimal("3.49")) == Decimal("96.51")

    def test_zero_gross(self):
        assert calculate_net_amount(Decimal("0.00")) == Decimal("0.00")

    def test_fee_equals_gross(self):
        assert calculate_net_amount(Decimal("10.00"), Decimal("10.00")) == Decimal("0.00")

    def test_precision(self):
        """Decimal precision must be exact — no floating point drift."""
        result = calculate_net_amount(Decimal("99.99"), Decimal("2.99"))
        assert result == Decimal("97.00")

    def test_string_input_handling(self):
        """Ensure string-like Decimal inputs work correctly."""
        result = calculate_net_amount(Decimal("250.00"), Decimal("7.50"))
        assert result == Decimal("242.50")


class TestCalculateItemProfit:
    def test_basic_profit(self):
        result = calculate_item_profit(
            actual_sell_price=Decimal("250.00"),
            buy_price=Decimal("120.00"),
        )
        assert result == Decimal("130.00")

    def test_profit_with_fee(self):
        result = calculate_item_profit(
            actual_sell_price=Decimal("250.00"),
            buy_price=Decimal("120.00"),
            fee_amount=Decimal("10.00"),
        )
        assert result == Decimal("120.00")

    def test_loss(self):
        """Sold below cost — should be negative."""
        result = calculate_item_profit(
            actual_sell_price=Decimal("80.00"),
            buy_price=Decimal("120.00"),
        )
        assert result == Decimal("-40.00")

    def test_break_even(self):
        result = calculate_item_profit(
            actual_sell_price=Decimal("120.00"),
            buy_price=Decimal("120.00"),
        )
        assert result == Decimal("0.00")

    def test_high_fees_cause_loss(self):
        """Large fees can turn a profitable sale into a loss."""
        result = calculate_item_profit(
            actual_sell_price=Decimal("150.00"),
            buy_price=Decimal("120.00"),
            fee_amount=Decimal("50.00"),
        )
        assert result == Decimal("-20.00")
