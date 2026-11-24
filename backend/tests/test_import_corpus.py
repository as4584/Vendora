"""Real-world spreadsheet corpus: every file a store might hand us goes through
the whole flow (upload -> preview -> commit) and must land correctly.

Each case is a file shaped like something sellers actually export: Excel on
Windows/Mac, Google Sheets, Numbers, LibreOffice, Shopify/Square-style
exports, European number formats, title rows, size grids, junk cells.
A case never gets a 500, and checks what ends up in inventory.
"""
import base64
import io
from datetime import date, datetime
from decimal import Decimal

import pytest
from openpyxl import Workbook

from app.models.inventory import InventoryItem
from app.routers import inventory as inventory_router

PREVIEW = "/api/v1/inventory/imports/preview"
UPLOADS = "/api/v1/inventory/imports/uploads"


def _xlsx(sheets: list[list[list]], *, titles=None, before=None) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    for i, rows in enumerate(sheets):
        ws = wb.create_sheet(title=(titles or [f"Sheet{j + 1}" for j in range(len(sheets))])[i])
        for row in rows:
            ws.append(row)
        if before:
            before(ws, i)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def _items(db):
    return {i.name: i for i in db.query(InventoryItem).filter(InventoryItem.deleted_at.is_(None)).all()}


@pytest.fixture()
def run(client, db, auth_headers, monkeypatch, tmp_path):
    """Preview + commit a file the way the app does (xlsx in the background)."""
    monkeypatch.setattr(inventory_router, "IMPORT_UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(inventory_router, "_run_import_job", lambda work: work(db))

    def go(filename: str, content: bytes, *, commit: bool = True, chunked: bool | None = None):
        chunked = filename.lower().endswith(".xlsx") if chunked is None else chunked
        if chunked:
            start = client.post(UPLOADS, json={"filename": filename, "size": len(content)}, headers=auth_headers)
            assert start.status_code == 201, start.text
            upload_id = start.json()["upload_id"]
            for index, offset in enumerate(range(0, max(len(content), 1), 64 * 1024)):
                part = base64.b64encode(content[offset:offset + 64 * 1024]).decode()
                assert client.put(f"{UPLOADS}/{upload_id}", json={"index": index, "data": part},
                                  headers=auth_headers).status_code == 200
            resp = client.post(f"{UPLOADS}/{upload_id}/preview", json={"filename": filename}, headers=auth_headers)
            assert resp.status_code in (201, 202, 400, 413), resp.text
            if resp.status_code == 202:
                job_id = resp.json()["job_id"]
                job = client.get(f"/api/v1/inventory/imports/{job_id}", headers=auth_headers).json()
                if job["status"] == "failed":
                    return {"error": job["error"]}
                resp = client.get(f"/api/v1/inventory/imports/{job_id}/preview", headers=auth_headers)
        else:
            resp = client.post(PREVIEW, files={"file": (filename, content, "application/octet-stream")},
                               headers=auth_headers)
        assert resp.status_code != 500, resp.text
        if resp.status_code != 201 and resp.status_code != 200:
            return {"error": resp.json()["detail"], "status": resp.status_code}
        preview = resp.json()
        if commit:
            done = client.post(f"/api/v1/inventory/imports/{preview['job_id']}/commit", headers=auth_headers)
            assert done.status_code == 200, done.text
            preview["commit"] = done.json()
        return preview

    return go


# ── CSV flavours ──────────────────────────────────────────────────────────────

def test_excel_windows_csv_cp1252_with_currency(run, db):
    content = 'Product Name,SKU,Qty,Cost,Price\r\nCafé Dunk,CD-1,2,"$1,200.00",$1500\r\n'.encode("cp1252")
    out = run("stock.csv", content)
    assert out["commit"]["rows_created"] == 1
    item = _items(db)["Café Dunk"]
    assert item.buy_price == Decimal("1200.00") and item.expected_sell_price == Decimal("1500.00") and item.quantity == 2


def test_utf8_bom_and_emoji(run, db):
    content = "﻿Name,SKU,Notes\nJordan 4 🔥 Black Cat,J4-BC,Señor's pick — 💯\n".encode("utf-8")
    run("bom.csv", content)
    item = _items(db)["Jordan 4 🔥 Black Cat"]
    assert item.sku == "J4-BC" and item.notes == "Señor's pick — 💯"


def test_european_semicolon_csv(run, db):
    content = "Name;SKU;Qty;Cost;Price\nAir Max 90;AM90;3;1.234,56 €;99,50\n".encode()
    run("eu.csv", content)
    item = _items(db)["Air Max 90"]
    assert item.buy_price == Decimal("1234.56") and item.expected_sell_price == Decimal("99.50") and item.quantity == 3


def test_tab_separated_txt(run, db):
    run("export.txt", b"Item Name\tSKU\tQuantity\nYeezy 350\tY350\t4\n")
    assert _items(db)["Yeezy 350"].quantity == 4


def test_title_rows_above_the_header_and_blank_rows(run, db):
    content = (
        "My Sneaker Store Inventory,,,\n"
        "Exported 3/14/2026,,,\n"
        ",,,\n"
        "Product Name,SKU,Size,Qty\n"
        "Dunk Low Panda,DD1391-100,10,1\n"
        ",,,\n"
        "Dunk Low Panda,DD1391-100,10.5,2\n"
        ",,,\n"
    ).encode()
    out = run("titled.csv", content)
    assert out["commit"]["rows_created"] == 2
    sizes = sorted(i.size for i in db.query(InventoryItem).filter_by(sku="DD1391-100"))
    assert sizes == ["10", "10.5"]


def test_quoted_commas_and_newlines_inside_cells(run, db):
    content = b'Name,SKU,Notes\n"Jordan 1, Chicago",J1-CHI,"Box damaged,\nmissing lid"\n'
    run("quoted.csv", content)
    assert _items(db)["Jordan 1, Chicago"].notes == "Box damaged,\nmissing lid"


def test_old_mac_cr_line_endings(run, db):
    run("mac.csv", b"Name,SKU,Qty\rNB 550,NB550,2\rNB 990,NB990,1\r")
    assert {"NB 550", "NB 990"} <= set(_items(db))


def test_alias_headers_from_other_tools(run, db):
    content = b"Title,Style Code,Colour,On Hand,Retail,Cost Basis,Supplier,Condition\nSamba OG,B75806,White/Black,5,100,62.5,Adidas,New\n"
    run("aliases.csv", content)
    item = _items(db)["Samba OG"]
    assert (item.sku, item.color, item.quantity) == ("B75806", "White/Black", 5)
    assert item.expected_sell_price == Decimal("100.00") and item.buy_price == Decimal("62.50")
    assert item.vendor_name == "Adidas" and item.condition == "New"


def test_quantity_and_price_shapes(run, db):
    content = (
        "Name,Qty,Price\n"
        "A two-point-oh,2.0,USD 40\n"
        "B pairs,3 pairs,40.5\n"
        "C sold out,0,10\n"
        "D blank qty,,10\n"
        "E bad qty,many,10\n"
        "F bad price,1,TBD\n"
        "G negative price,1,(5.00)\n"
        "H negative qty,-2,10\n"
    ).encode()
    out = run("shapes.csv", content)
    rows = {r["mapped_data"]["name"] if r["mapped_data"] else r["row_number"]: r for r in out["rows"]}
    errors = {r["row_number"]: r["error_message"] for r in out["rows"] if r["action"] == "error"}
    assert len(errors) == 4 and out["commit"]["rows_created"] == 4
    assert any("many" in e for e in errors.values()) and any("TBD" in e for e in errors.values())
    items = _items(db)
    assert items["A two-point-oh"].quantity == 2 and items["A two-point-oh"].expected_sell_price == Decimal("40.00")
    assert items["B pairs"].quantity == 3
    assert items["C sold out"].quantity == 0  # sold out stays sold out
    assert items["D blank qty"].quantity == 1
    assert rows  # every row came back


def test_no_name_column_uses_sku_and_long_values_are_trimmed(run, db):
    long_sku = "S" * 300
    content = f"SKU,Color,Notes\nAQ9129-100,{'Red' * 40},{'n' * 20000}\n{long_sku},Blue,x\n".encode()
    out = run("noname.csv", content)
    assert out["commit"]["rows_created"] == 2
    item = _items(db)["AQ9129-100"]
    assert len(item.color) == 50 and len(item.notes) == 20000
    assert db.query(InventoryItem).filter(InventoryItem.name == long_sku[:100]).one().sku == long_sku[:100]


def test_formula_cells_and_google_sheets_image(run, db):
    content = (
        b'Name,SKU,Image\n'
        b'"=HYPERLINK(""http://evil.test"",""Click"")",H1,"=IMAGE(""https://cdn.test/dunk.jpg"")"\n'
        b"Plain,P1,https://cdn.test/p.png\n"
    )
    run("formulas.csv", content)
    items = _items(db)
    assert items["Plain"].photo_front_url == "https://cdn.test/p.png"
    hyperlink = next(i for i in items.values() if i.sku == "H1")
    assert hyperlink.photo_front_url == "https://cdn.test/dunk.jpg"


def test_duplicate_and_unknown_headers_dont_break(run, db):
    content = b"Name,Price,Price,Internal Code,,SKU\nDupe,10,20,zz,,D-1\n"
    run("dupes.csv", content)
    assert _items(db)["Dupe"].expected_sell_price in (Decimal("10.00"), Decimal("20.00"))


def test_scientific_notation_upc_does_not_crash(run, db):
    run("sci.csv", b"Name,UPC\nSci,1.96153E+11\n")
    assert _items(db)["Sci"].upc == "1.96153E+11"


def test_header_only_and_empty_files_explain_themselves(run):
    for name, content in [("empty.csv", b""), ("blank.csv", b"\n\n\n"), ("header.csv", b"Name,SKU,Qty\n")]:
        out = run(name, content, commit=False)
        assert "error" in out or out["total_rows"] == 0, (name, out)
        if "error" in out:
            assert out["status"] == 400 and out["error"]


def test_html_saved_as_csv_is_rejected_clearly(run):
    out = run("download.csv", b"<!DOCTYPE html><html><body>Sign in</body></html>", commit=False)
    assert out["status"] == 400 and "web page" in out["error"]


def test_size_grid_keeps_each_size(run, db):
    content = b"Product,8,8.5,9,10\nJordan 4 Black Cat,1,0,2,1\nDunk Low Panda,0,3,0,0\n"
    out = run("grid.csv", content)
    assert out["commit"]["rows_created"] == 2
    item = _items(db)["Jordan 4 Black Cat"]
    assert item.quantity == 4
    assert {v["size"]: v["quantity"] for v in item.custom_attributes["variants"]} == {"8": 1, "8.5": 0, "9": 2, "10": 1}


# ── Re-imports ────────────────────────────────────────────────────────────────

def test_reimport_updates_each_size_instead_of_duplicating(run, db):
    sheet = "Name,SKU,Size,Qty\nDunk,DD1391-100,9,1\nDunk,DD1391-100,10,2\nDunk,DD1391-100,11,3\n"
    run("v1.csv", sheet.encode())
    out = run("v2.csv", sheet.replace(",1\n", ",0\n").encode())
    assert out["commit"]["rows_updated"] == 3 and out["commit"]["rows_created"] == 0
    stock = {i.size: i.quantity for i in db.query(InventoryItem).filter_by(sku="DD1391-100")}
    assert stock == {"9": 0, "10": 2, "11": 3}


def test_reimport_without_size_column_updates_a_single_item(run, db):
    run("a.csv", b"Name,SKU,Qty\nHat,HAT-1,5\n")
    out = run("b.csv", b"Name,SKU,Qty\nHat,HAT-1,0\n")
    assert out["commit"]["rows_updated"] == 1
    assert db.query(InventoryItem).filter_by(sku="HAT-1").one().quantity == 0


def test_sizes_written_differently_still_match(run, db):
    run("a.csv", b"Name,SKU,Size,Qty\nDunk,X1,US 10,1\n")
    out = run("b.csv", b"Name,SKU,Size,Qty\nDunk,x1,10,4\n")
    assert out["commit"]["rows_updated"] == 1


# ── Excel workbooks ──────────────────────────────────────────────────────────

def test_xlsx_typed_cells(run, db):
    content = _xlsx([[
        ["Product Name", "SKU", "UPC", "Qty", "Cost", "Price", "Purchased", "Sold?"],
        ["Typed", 12345, 196153282201, 2.0, 120.5, 199.999, datetime(2026, 3, 1), True],
        ["Date only", "D-1", None, 1, None, None, date(2026, 3, 2), False],
    ]])
    run("typed.xlsx", content)
    item = _items(db)["Typed"]
    assert item.sku == "12345" and item.upc == "196153282201" and item.quantity == 2
    assert item.buy_price == Decimal("120.50") and item.expected_sell_price == Decimal("200.00")


def test_xlsx_formulas_use_cached_values_or_skip(run, db):
    def formulas(ws, _):
        ws["D2"] = "=B2*2"

    content = _xlsx([[["Name", "Qty", "Cost", "Total"], ["Formula row", 2, 10, None]]], before=formulas)
    out = run("formulas.xlsx", content)
    assert out["commit"]["rows_created"] == 1 and _items(db)["Formula row"].quantity == 2


def test_xlsx_notes_sheet_first_then_data(run, db):
    content = _xlsx(
        [[["Read me: this workbook tracks stock"]], [["Name", "SKU", "Qty"], ["Second sheet item", "S2", 1]]],
        titles=["Notes", "Inventory"],
    )
    run("notes-first.xlsx", content)
    assert "Second sheet item" in _items(db)


def test_xlsx_merged_title_and_frozen_header(run, db):
    def style(ws, _):
        ws.merge_cells("A1:C1")
        ws.freeze_panes = "A3"

    content = _xlsx([[["Spring Stock", None, None], ["Name", "SKU", "Qty"], ["Merged", "M-1", 3]]], before=style)
    run("merged.xlsx", content)
    assert _items(db)["Merged"].quantity == 3


def test_xlsx_hidden_columns_and_wide_sheet(run, db):
    header = ["Name", "SKU"] + [f"Extra {i}" for i in range(200)]
    row = ["Wide", "W-1"] + [i for i in range(200)]

    def hide(ws, _):
        ws.column_dimensions["B"].hidden = True

    run("wide.xlsx", _xlsx([[header, row]], before=hide))
    assert _items(db)["Wide"].sku == "W-1"


def test_xlsx_ten_thousand_rows(run, db):
    rows = [["Name", "SKU", "Size", "Qty", "Cost"]] + [
        [f"Shoe {i}", f"SKU-{i // 10}", str(7 + (i % 10) / 2), i % 4, 50 + i % 90] for i in range(10_000)
    ]
    out = run("big.xlsx", _xlsx([rows]))
    assert out["total_rows"] == 10_000 and out["commit"]["rows_created"] == 10_000
    assert db.query(InventoryItem).count() == 10_000


def test_corrupt_and_wrong_files(run):
    for name, content in [
        ("broken.xlsx", b"PK\x03\x04garbage"),
        ("pdf.xlsx", b"%PDF-1.7 not a sheet"),
        ("old.xls", b"\xd0\xcf\x11\xe0"),
        ("photo.jpg", b"\xff\xd8\xff"),
    ]:
        out = run(name, content, commit=False, chunked=name.endswith(".xlsx"))
        assert "error" in out, name
        assert "Traceback" not in out["error"] and len(out["error"]) < 300
