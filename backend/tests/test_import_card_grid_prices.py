"""Card-grid warehouse sheets (one product card per 4 columns) hide the price in different spots."""
import csv
import io

from app.services.spreadsheet_import import parse_inventory_rows, rows_from_bytes


def _csv(rows):
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue().encode()


def _by_name(rows):
    parsed = parse_inventory_rows(rows_from_bytes(_csv(rows), "csv"))
    return {p.payload["name"]: p.payload for p in parsed}


def test_price_under_name():
    items = _by_name([
        ["Shattered Fist Tee Black", "Total", "15", "", "Dog Tag Tee Black", "Total", "14"],
        ["$80", "", "", "", "$80", "", ""],
        ["", "Size", "QTY", "", "", "Size", "QTY"],
        ["", "M", "5", "", "", "M", "4"],
        ["", "L", "10", "", "", "L", "10"],
    ])
    assert items["Shattered Fist Tee Black"]["expected_sell_price"] == "80.00"
    assert items["Dog Tag Tee Black"]["expected_sell_price"] == "80.00"
    assert "$80" not in items


def test_price_in_name_and_in_total_slot():
    items = _by_name([
        ["Accolade Hoodie Black $120", "Total", "8", "", "SAND BELUGA HOODIE", "$60", ""],
        ["", "Size", "QTY", "", "", "Size", "QTY"],
        ["", "S", "3", "", "", "L", "10"],
        ["", "M", "5", "", "", "", ""],
    ])
    assert items["Accolade Hoodie Black"]["expected_sell_price"] == "120.00"
    assert items["SAND BELUGA HOODIE"]["expected_sell_price"] == "60.00"
    assert items["Accolade Hoodie Black"]["quantity"] == 8
