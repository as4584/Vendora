"""Randomised spreadsheets through the real import flow: it must never crash.

Seeded, so a failure reproduces: the assertion message names the seed. Each
sheet mixes real-world mess: header aliases in any case/spacing, junk and
unicode values, money and quantity in many shapes, blank and title rows,
separators, encodings, CSV vs XLSX.
"""
import io
import os
import random

import pytest
from openpyxl import Workbook

from app.models.inventory import InventoryItem

PREVIEW = "/api/v1/inventory/imports/preview"

HEADERS = {
    "name": ["Name", "Product Name", "ITEM", "title", " Item Name ", "Description"],
    "sku": ["SKU", "Style Code", "style", "Item Number", "sku "],
    "upc": ["UPC", "Barcode", "EAN", "GTIN"],
    "size": ["Size", "Shoe Size", "size"],
    "color": ["Color", "Colour", "COLORWAY"],
    "qty": ["Qty", "Quantity", "On Hand", "Stock", "count"],
    "cost": ["Cost", "Buy Price", "Cost Basis", "Paid"],
    "price": ["Price", "Retail", "List Price", "Asking Price"],
    "notes": ["Notes", "Memo"],
    "junk": ["Internal", "", "Column1", "🔥", "Location", "Bin #"],
}
NAMES = ["Dunk Low", "Jordan 4 Black Cat", "Samba OG", "Air Max 90", "Café Racer", "日本限定", "Yeezy 350 V2 \"Zebra\"",
         "=cmd|' /C calc'!A0", "Size 10 Hat, Red", "", "  ", "x" * 400]
MONEY = ["$120", "120.00", "1,200.50", "1.200,50 €", "USD 40", "", "free", "TBD", "(5)", "-3", "0", "99.999", "£75", "1e3", "12,5"]
QTY = ["1", "2.0", "3 pairs", "", "0", "-1", "many", "1,000", "4.5", " 7 ", "N/A"]
SIZES = ["10", "10.5", "US 9", "M", "XL", "", "8.5W", "EU 42", "One Size"]
JUNK = ["", "—", "null", "None", "#N/A", "#VALUE!", "TRUE", "\t", "🔥🔥", "a\nb", "\"quoted\"", ";", "😀" * 50]


def _sheet(rng: random.Random) -> tuple[list[str], list[list[str]]]:
    keys = rng.sample(list(HEADERS), rng.randint(1, len(HEADERS)))
    if rng.random() < 0.85 and "name" not in keys:
        keys.insert(0, "name")
    header = [rng.choice(HEADERS[k]) for k in keys]
    rows = []
    for _ in range(rng.randint(0, 25)):
        row = []
        for k in keys:
            row.append({
                "name": lambda: rng.choice(NAMES),
                "sku": lambda: rng.choice(["DD1391-100", "dd1391-100", "AQ-1", "", "12345", "S" * 150]),
                "upc": lambda: rng.choice(["196153282201", "0196153282201", "1.96E+11", "", "abc"]),
                "size": lambda: rng.choice(SIZES),
                "color": lambda: rng.choice(["Black", "White/Red", "", "Bred" * 30]),
                "qty": lambda: rng.choice(QTY),
                "cost": lambda: rng.choice(MONEY),
                "price": lambda: rng.choice(MONEY),
                "notes": lambda: rng.choice(JUNK + ["n" * 5000]),
                "junk": lambda: rng.choice(JUNK),
            }[k]())
        rows.append(row)
        if rng.random() < 0.1:
            rows.append([""] * len(keys))
    if rng.random() < 0.2:
        rows = [["My Store"] + [""] * (len(keys) - 1), [""] * len(keys)] + [header] + rows
        header = None
    return header, rows


def _csv_bytes(rng, header, rows) -> bytes:
    import csv

    sep = rng.choice([",", ",", ";", "\t", "|"])
    out = io.StringIO()
    writer = csv.writer(out, delimiter=sep, lineterminator=rng.choice(["\n", "\r\n", "\r"]))
    if header:
        writer.writerow(header)
    writer.writerows(rows)
    text = out.getvalue()
    encoding = rng.choice(["utf-8", "utf-8-sig", "cp1252"])
    return text.encode(encoding, errors="replace")


def _xlsx_bytes(rng, header, rows) -> bytes:
    wb = Workbook()
    ws = wb.active
    for row in ([header] if header else []) + rows:
        clean = []
        for value in row:
            value = "".join(ch for ch in value if ch >= " " or ch in "\t\n")  # Excel forbids control chars
            if rng.random() < 0.2:
                try:
                    clean.append(float(value.replace(",", "")))
                    continue
                except ValueError:
                    pass
            clean.append(value or None)
        ws.append(clean)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


# CI runs 150 sheets; set IMPORT_FUZZ_SEEDS=2000 locally to dig deeper.
@pytest.mark.parametrize("seed", range(int(os.environ.get("IMPORT_FUZZ_SEEDS", "150"))))
def test_random_sheets_never_crash(seed, client, db, auth_headers):
    rng = random.Random(seed)
    header, rows = _sheet(rng)
    as_xlsx = rng.random() < 0.4
    content = _xlsx_bytes(rng, header, rows) if as_xlsx else _csv_bytes(rng, header, rows)
    name = "fuzz.xlsx" if as_xlsx else rng.choice(["fuzz.csv", "fuzz.txt"])

    resp = client.post(PREVIEW, files={"file": (name, content, "application/octet-stream")}, headers=auth_headers)
    assert resp.status_code in (201, 400), f"seed={seed}: {resp.status_code} {resp.text[:300]}"
    if resp.status_code == 400:
        assert resp.json()["detail"], f"seed={seed}: empty error"
        return
    preview = resp.json()
    importable = preview["rows_to_create"] + preview["rows_to_update"]
    for row in preview["rows"]:
        if row["action"] == "error":
            assert row["error_message"], f"seed={seed}: error row without a reason"

    before = db.query(InventoryItem).count()
    commit = client.post(f"/api/v1/inventory/imports/{preview['job_id']}/commit", headers=auth_headers)
    assert commit.status_code == 200, f"seed={seed}: commit {commit.status_code} {commit.text[:300]}"
    body = commit.json()
    assert body["rows_created"] + body["rows_updated"] == importable, f"seed={seed}: {body}"
    assert db.query(InventoryItem).count() == before + body["rows_created"], f"seed={seed}"
    for item in db.query(InventoryItem).all():
        assert item.name and item.quantity >= 0, f"seed={seed}: bad item {item.name!r} qty={item.quantity}"
        for price in (item.buy_price, item.expected_sell_price):
            assert price is None or price >= 0, f"seed={seed}: negative price"
