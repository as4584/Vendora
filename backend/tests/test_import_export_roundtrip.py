"""Export → re-import must be lossless, and import parsing must never guess silently.

Covers the cases from the 2026-11-02 import/export review
(docs/roadmap/PERFECTION_PLAN.md, P0.3-P0.5).
"""
import csv
import io

import pytest

from app.models.inventory import InventoryItem
from app.services.csv_export import safe_cell
from app.services.spreadsheet_import import (
    parse_inventory_rows,
    parse_money,
    parse_quantity,
    parse_size_breakdown,
    parse_status,
    rows_from_bytes,
    unescape_cell,
)

API = "/api/v1"


@pytest.fixture
def pro_headers(client, auth_headers, db, test_user):
    test_user.subscription_tier = "pro"
    db.add(test_user)
    db.commit()
    return auth_headers


def _export(client, headers, fmt="csv") -> bytes:
    resp = client.get(f"{API}/export/inventory?format={fmt}", headers=headers)
    assert resp.status_code == 200
    return resp.content


def _import(client, headers, content: bytes, name="inventory.csv", dry_run=False):
    resp = client.post(
        f"{API}/inventory/import/file?dry_run={'true' if dry_run else 'false'}",
        files={"file": (name, content, "text/csv")},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _items(db, user_id):
    return (
        db.query(InventoryItem)
        .filter(InventoryItem.user_id == user_id, InventoryItem.deleted_at.is_(None))
        .order_by(InventoryItem.name)
        .all()
    )


FIELDS = (
    "name", "category", "sku", "upc", "size", "color", "condition", "quantity",
    "buy_price", "expected_sell_price", "actual_sell_price", "status",
    "platform", "vendor_name", "notes",
)


def _snapshot(items):
    return {str(i.id): {f: getattr(i, f) for f in FIELDS} for i in items}


# ── Round trip ────────────────────────────────────────────────────────────────


class TestRoundTrip:
    def _seed(self, client, headers):
        client.post(f"{API}/inventory", json={
            "name": "Jordan 1 Chicago", "sku": "555088-101", "upc": "00195866123456",
            "size": "10", "color": "Red", "condition": "new", "quantity": 1,
            "buy_price": "170.00", "expected_sell_price": "1200.00",
            "platform": "StockX", "vendor_name": "Nike SNKRS", "notes": "OG all",
        }, headers=headers)
        # Manual item with no SKU/UPC: used to duplicate on every re-import.
        client.post(f"{API}/inventory", json={
            "name": "Charizard Base Set Holo", "category": "cards", "quantity": 1,
            "buy_price": "300.00", "vendor_name": "Card show", "notes": "PSA 8",
        }, headers=headers)
        # Hostile text: must not become a live formula, must come back unchanged.
        client.post(f"{API}/inventory", json={
            "name": "=HYPERLINK(\"http://evil\")", "notes": "+1 extra laces", "quantity": 2,
            "buy_price": "5.00", "vendor_name": "@vendor",
        }, headers=headers)
        client.post(f"{API}/inventory", json={
            "name": "Pokémon Tee ½ off ™", "quantity": 3, "buy_price": "12.50",
            "custom_attributes": {"variants": [{"size": "S", "quantity": 1}, {"size": "M", "quantity": 2}]},
        }, headers=headers)

    def test_csv_export_then_import_is_lossless(self, client, pro_headers, db, test_user):
        self._seed(client, pro_headers)
        before = _snapshot(_items(db, test_user.id))

        result = _import(client, pro_headers, _export(client, pro_headers))

        assert result["created"] == 0
        assert result["updated"] == 4
        assert result["errors"] == []
        db.expire_all()
        after_items = _items(db, test_user.id)
        assert _snapshot(after_items) == before
        tee = next(i for i in after_items if i.name.startswith("Pokémon"))
        assert tee.custom_attributes["variants"] == [{"size": "S", "quantity": 1}, {"size": "M", "quantity": 2}]

    def test_reimporting_twice_is_idempotent(self, client, pro_headers, db, test_user):
        self._seed(client, pro_headers)
        exported = _export(client, pro_headers)
        _import(client, pro_headers, exported)
        before = _snapshot(_items(db, test_user.id))
        second = _import(client, pro_headers, exported)
        assert second["created"] == 0
        db.expire_all()
        assert _snapshot(_items(db, test_user.id)) == before

    def test_renamed_row_updates_instead_of_duplicating(self, client, pro_headers, db, test_user):
        self._seed(client, pro_headers)
        text = _export(client, pro_headers).decode("utf-8-sig")
        text = text.replace("Charizard Base Set Holo", "Charizard Base Set Holo 1st Ed")
        result = _import(client, pro_headers, text.encode("utf-8"))
        assert result["created"] == 0
        db.expire_all()
        names = [i.name for i in _items(db, test_user.id)]
        assert "Charizard Base Set Holo 1st Ed" in names
        assert "Charizard Base Set Holo" not in names

    def test_vendor_survives_round_trip_despite_source_column(self, client, pro_headers, db, test_user):
        self._seed(client, pro_headers)
        _import(client, pro_headers, _export(client, pro_headers))
        db.expire_all()
        vendors = {i.name: i.vendor_name for i in _items(db, test_user.id)}
        assert vendors["Jordan 1 Chicago"] == "Nike SNKRS"
        assert vendors["Charizard Base Set Holo"] == "Card show"

    def test_other_users_ids_are_never_matched(self, client, pro_headers, db, test_user):
        from app.models.user import User

        stranger = User(email="stranger@example.com", password_hash="x")
        db.add(stranger)
        db.flush()
        theirs = InventoryItem(user_id=stranger.id, name="Their item", quantity=1)
        db.add(theirs)
        db.commit()
        content = f"id,name,quantity\n{theirs.id},Hijack,9\n".encode()
        result = _import(client, pro_headers, content)
        assert result["created"] == 1  # a new item for this user, not an update
        db.refresh(theirs)
        assert theirs.name == "Their item" and theirs.quantity == 1

    def test_xlsx_export_then_import_is_lossless(self, client, pro_headers, db, test_user):
        self._seed(client, pro_headers)
        before = _snapshot(_items(db, test_user.id))
        content = _export(client, pro_headers, fmt="xlsx")
        resp = client.post(
            f"{API}/inventory/import/file?dry_run=false",
            files={"file": ("inventory.xlsx", content,
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            headers=pro_headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["created"] == 0
        db.expire_all()
        assert _snapshot(_items(db, test_user.id)) == before


# ── Export safety ─────────────────────────────────────────────────────────────


class TestExportSafety:
    def test_csv_has_bom_and_escapes_formulas(self, client, pro_headers):
        client.post(f"{API}/inventory", json={"name": "=1+1", "notes": "-2", "quantity": 1}, headers=pro_headers)
        content = _export(client, pro_headers)
        assert content.startswith(b"\xef\xbb\xbf")
        rows = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
        assert rows[0]["name"] == "'=1+1"
        assert rows[0]["notes"] == "'-2"
        # Our own IMAGE formulas are intentional and stay formulas.
        assert all(not r["front_image_formula"] or r["front_image_formula"].startswith("=IMAGE(") for r in rows)

    def test_xlsx_never_writes_user_text_as_formula(self, client, pro_headers):
        from openpyxl import load_workbook

        client.post(f"{API}/inventory", json={"name": "=cmd|'/c calc'!A1", "quantity": 1}, headers=pro_headers)
        wb = load_workbook(io.BytesIO(_export(client, pro_headers, fmt="xlsx")))
        cell = wb.active.cell(row=2, column=2)
        assert cell.data_type == "s"
        assert cell.value == "=cmd|'/c calc'!A1"

    def test_transactions_csv_escapes_notes(self, client, pro_headers):
        client.post(f"{API}/transactions", json={"method": "cash", "gross_amount": "10.00", "notes": "@SUM(A1)"},
                    headers=pro_headers)
        resp = client.get(f"{API}/export/transactions", headers=pro_headers)
        rows = list(csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))))
        assert rows[0]["Notes"] == "'@SUM(A1)"

    @pytest.mark.parametrize("value", ["=x", "+x", "-x", "@x", "\tx", "\rx"])
    def test_safe_cell_and_unescape_are_inverse(self, value):
        assert safe_cell(value).startswith("'")
        assert unescape_cell(safe_cell(value)) == value

    def test_safe_cell_leaves_normal_values(self):
        assert safe_cell("Jordan 1") == "Jordan 1"
        assert safe_cell(5) == 5
        assert unescape_cell("'quoted already") == "'quoted already"


# ── Parsing: never guess silently ─────────────────────────────────────────────


class TestMoney:
    @pytest.mark.parametrize("raw,expected", [
        ("$1,200.00", "1200.00"),
        ("1.234,56 €", "1234.56"),
        ("1.234.567", "1234567.00"),
        ("12,5", "12.50"),
        ("USD 40", "40.00"),
        ("0", "0.00"),
        ("19.99", "19.99"),
        ("1,234", "1234.00"),
    ])
    def test_formats(self, raw, expected):
        assert parse_money(raw) == (expected, None)

    @pytest.mark.parametrize("raw", ["-5", "(5.00)", "free", "TBD"])
    def test_rejected_with_warning(self, raw):
        amount, warning = parse_money(raw)
        assert amount is None
        assert warning and raw in warning

    def test_blank_is_silent(self):
        assert parse_money("") == (None, None)
        assert parse_money(None) == (None, None)


class TestQuantity:
    @pytest.mark.parametrize("raw,expected,warns", [
        ("3", 3, False),
        ("1,200", 1200, False),
        ("2.0", 2, False),
        ("2.5", 2, True),
        ("", 1, True),
        ("-1", 0, True),
        ("lots", 1, True),
        ("about 4", 4, True),
        ("5pcs", 5, False),
    ])
    def test_cases(self, raw, expected, warns):
        qty, warning = parse_quantity(raw)
        assert qty == expected
        assert bool(warning) is warns


class TestStatus:
    def test_known_and_unknown(self):
        assert parse_status("For Sale") == ("listed", None)
        assert parse_status("") == ("in_stock", None)
        status, warning = parse_status("Consigned")
        assert status == "in_stock" and "Consigned" in warning


class TestColumnsAndEncoding:
    def test_name_beats_description_regardless_of_order(self):
        rows = [{"Description": "Long text about the shoe", "Name": "Dunk Low Panda", "Qty": "1"}]
        assert parse_inventory_rows(rows)[0].payload["name"] == "Dunk Low Panda"

    def test_parse_warnings_reach_the_row(self):
        rows = [{"Name": "Card", "Price": "free", "Qty": "2.5", "Status": "Graded"}]
        warnings = " ".join(parse_inventory_rows(rows)[0].warnings)
        assert "free" in warnings and "2.5" in warnings and "Graded" in warnings

    def test_windows_1252_csv(self):
        content = "Name,Qty\nPokémon ™ ½,1\n".encode("cp1252")
        rows = rows_from_bytes(content, "csv")
        assert parse_inventory_rows(rows)[0].payload["name"] == "Pokémon ™ ½"

    def test_utf8_bom_csv_with_emoji(self):
        content = "﻿Name,Qty\nCharizard 🔥,1\n".encode("utf-8")
        rows = rows_from_bytes(content, "csv")
        assert parse_inventory_rows(rows)[0].payload["name"] == "Charizard 🔥"

    def test_semicolon_csv_with_comma_decimals(self):
        content = "Name;Cost;Qty\nJordan 4;189,50;2\n".encode("utf-8")
        payload = parse_inventory_rows(rows_from_bytes(content, "csv"))[0].payload
        assert payload["buy_price"] == "189.50"
        assert payload["quantity"] == 2

    def test_size_breakdown_parses(self):
        assert parse_size_breakdown("S (1); M (3); 10.5 (2)") == [
            {"size": "S", "quantity": 1}, {"size": "M", "quantity": 3}, {"size": "10.5", "quantity": 2},
        ]
        assert parse_size_breakdown("") == []

    def test_user_source_column_still_means_vendor(self):
        rows = [{"Name": "Hoodie", "Source": "Goodwill Bins", "Qty": "1"}]
        assert parse_inventory_rows(rows)[0].payload["vendor_name"] == "Goodwill Bins"


class TestDuplicatesInOneFile:
    def test_same_sku_twice_creates_once(self, client, pro_headers, db, test_user):
        content = b"Name,SKU,Qty\nDunk Low,DD1391-100,1\nDunk Low,DD1391-100,3\n"
        result = _import(client, pro_headers, content)
        assert result["created"] == 1
        assert result["updated"] == 1
        db.expire_all()
        items = _items(db, test_user.id)
        assert len(items) == 1 and items[0].quantity == 3


class TestTierLimit:
    def test_rows_over_limit_are_reported(self, client, auth_headers, db, test_user):
        test_user.subscription_tier = "free"
        db.add(test_user)
        db.commit()
        from app.routers.inventory import TIER_LIMITS as ROUTER_LIMITS

        limit = ROUTER_LIMITS["free"]
        lines = ["Name,SKU,Qty"] + [f"Item {n},SKU-{n},1" for n in range(limit + 3)]
        result = _import(client, auth_headers, "\n".join(lines).encode())
        assert result["created"] == limit
        over = [e["row"] for e in result["errors"]]
        assert over == list(range(limit + 2, limit + 5))
