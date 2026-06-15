"""Inventory spreadsheet import tests."""
import io

from openpyxl import Workbook
from openpyxl.drawing.image import Image as WorkbookImage
from PIL import Image
from app.services.spreadsheet_import import google_sheet_export_urls


CSV_CONTENT = """Product Name,Brand,SKU,Category,Cost,List Price,Qty,Image URL,Condition
Jordan 4 Military Blue,Nike,J4-MB-10,Sneakers,$120.00,$260.00,2,https://example.com/j4.jpg,New
Vintage Denim Jacket,Levis,LV-JKT-M,Clothing,25,80,1,,Used
"""

WAREHOUSE_MATRIX_CSV = """,
"The Cotton Wreath Hoodie
Black",,,,"The Cotton Wreath Hoodie
Navy",,
,,,,,,
,,,,,,
,,,,,,
,Size,QTY,,,Size,QTY
,XS,0,,,XS,1
,S,1,,,S,0
,M,2,,,M,3
"""


def _xlsx_bytes(rows):
    workbook = Workbook()
    sheet = workbook.active
    for row in rows:
        sheet.append(row)
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


def _warehouse_xlsx_with_image_bytes():
    workbook = Workbook()
    sheet = workbook.active
    rows = [
        [None, None, None],
        ["The Cotton Wreath Hoodie\nBlack", None, None],
        [None, None, None],
        [None, None, None],
        [None, None, None],
        [None, "Size", "QTY"],
        [None, "S", 1],
        [None, "M", 2],
    ]
    for row in rows:
        sheet.append(row)

    image_bytes = io.BytesIO()
    Image.new("RGB", (8, 8), color=(16, 80, 160)).save(image_bytes, format="PNG")
    image_bytes.seek(0)
    sheet.add_image(WorkbookImage(image_bytes), "A3")

    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


def test_import_inventory_csv_file_creates_items(client, auth_headers):
    resp = client.post(
        "/api/v1/inventory/import/file",
        files={"file": ("inventory.csv", CSV_CONTENT, "text/csv")},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["rows_seen"] == 2
    assert data["created"] == 2
    assert data["updated"] == 0
    assert data["skipped"] == 0

    items_resp = client.get("/api/v1/inventory?per_page=10", headers=auth_headers)
    items = items_resp.json()["items"]
    assert {item["name"] for item in items} == {
        "Jordan 4 Military Blue",
        "Vintage Denim Jacket",
    }
    jordan = next(item for item in items if item["sku"] == "J4-MB-10")
    assert jordan["quantity"] == 2
    assert jordan["buy_price"] == "120.00"
    assert jordan["expected_sell_price"] == "260.00"
    assert jordan["photo_front_url"] == "https://example.com/j4.jpg"
    assert jordan["custom_attributes"]["brand"] == "Nike"


def test_import_inventory_warehouse_size_qty_matrix(client, auth_headers):
    resp = client.post(
        "/api/v1/inventory/import/file",
        files={"file": ("warehouse.csv", WAREHOUSE_MATRIX_CSV, "text/csv")},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["rows_seen"] == 2
    assert data["created"] == 2
    assert data["skipped"] == 0

    items_resp = client.get("/api/v1/inventory?per_page=10", headers=auth_headers)
    items = items_resp.json()["items"]
    black = next(item for item in items if item["color"] == "Black")
    navy = next(item for item in items if item["color"] == "Navy")

    assert black["name"] == "The Cotton Wreath Hoodie Black"
    assert black["category"] == "Hoodie"
    assert black["quantity"] == 3
    assert black["custom_attributes"]["variants"] == [
        {"size": "XS", "quantity": 0},
        {"size": "S", "quantity": 1},
        {"size": "M", "quantity": 2},
    ]
    assert navy["quantity"] == 4


def test_import_inventory_warehouse_xlsx_embedded_image(client, auth_headers):
    resp = client.post(
        "/api/v1/inventory/import/file",
        files={
            "file": (
                "warehouse.xlsx",
                _warehouse_xlsx_with_image_bytes(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
        headers=auth_headers,
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["created"] == 1

    items_resp = client.get("/api/v1/inventory?per_page=10", headers=auth_headers)
    item = items_resp.json()["items"][0]
    assert item["name"] == "The Cotton Wreath Hoodie Black"
    assert item["quantity"] == 3
    assert item["photo_front_url"].startswith("data:image/jpeg;base64,")


def test_import_inventory_extracts_photo_url_from_image_formula(client, auth_headers):
    csv_content = '''Product Name,Qty,Image URL
Formula Photo Hoodie,1,"=IMAGE(""https://cdn.example.com/front.jpg"")"
'''

    resp = client.post(
        "/api/v1/inventory/import/file",
        files={"file": ("inventory.csv", csv_content, "text/csv")},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    items_resp = client.get("/api/v1/inventory?per_page=10", headers=auth_headers)
    item = items_resp.json()["items"][0]
    assert item["photo_front_url"] == "https://cdn.example.com/front.jpg"


def test_import_inventory_csv_file_dry_run_does_not_create_items(client, auth_headers):
    resp = client.post(
        "/api/v1/inventory/import/file?dry_run=true",
        files={"file": ("inventory.csv", CSV_CONTENT, "text/csv")},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["dry_run"] is True
    assert data["rows_importable"] == 2
    assert data["created"] == 2

    items_resp = client.get("/api/v1/inventory", headers=auth_headers)
    assert items_resp.json()["total"] == 0


def test_import_inventory_csv_file_updates_existing_sku(client, auth_headers):
    client.post(
        "/api/v1/inventory",
        json={"name": "Old Name", "sku": "J4-MB-10", "quantity": 1},
        headers=auth_headers,
    )

    resp = client.post(
        "/api/v1/inventory/import/file",
        files={"file": ("inventory.csv", CSV_CONTENT, "text/csv")},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["created"] == 1
    assert data["updated"] == 1

    items_resp = client.get("/api/v1/inventory?per_page=10", headers=auth_headers)
    assert items_resp.json()["total"] == 2
    jordan = next(item for item in items_resp.json()["items"] if item["sku"] == "J4-MB-10")
    assert jordan["name"] == "Jordan 4 Military Blue"
    assert jordan["quantity"] == 2


def test_import_inventory_from_read_only_link(client, auth_headers, monkeypatch):
    from app.routers import inventory as inventory_router

    class FakeResponse:
        headers = {"content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
        content = _xlsx_bytes([
            ["Product Name", "Brand", "SKU", "Category", "Cost", "List Price", "Qty", "Image URL", "Condition"],
            ["Jordan 4 Military Blue", "Nike", "J4-MB-10", "Sneakers", "$120.00", "$260.00", 2, "https://example.com/j4.jpg", "New"],
            ["Vintage Denim Jacket", "Levis", "LV-JKT-M", "Clothing", 25, 80, 1, None, "Used"],
        ])

        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url):
            assert url == "https://docs.google.com/spreadsheets/d/example/export?format=xlsx"
            return FakeResponse()

    monkeypatch.setattr(inventory_router.httpx, "AsyncClient", FakeAsyncClient)

    resp = client.post(
        "/api/v1/inventory/import",
        json={"url": "https://docs.google.com/spreadsheets/d/example/edit?usp=sharing"},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["created"] == 2
    assert data["rows_importable"] == 2


def test_import_link_uses_google_sheet_gid_fragment(client, auth_headers, monkeypatch):
    from app.routers import inventory as inventory_router

    class FakeResponse:
        headers = {"content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
        content = _xlsx_bytes([
            ["Product Name", "Qty"],
            ["Jordan 4 Military Blue", 2],
            ["Vintage Denim Jacket", 1],
        ])

        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url):
            assert url == "https://docs.google.com/spreadsheets/d/example/export?format=xlsx"
            return FakeResponse()

    monkeypatch.setattr(inventory_router.httpx, "AsyncClient", FakeAsyncClient)

    resp = client.post(
        "/api/v1/inventory/import",
        json={"url": "https://docs.google.com/spreadsheets/d/example/edit?usp=sharing#gid=987654321"},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    assert resp.json()["rows_importable"] == 2


def test_google_sheet_export_urls_accept_account_scoped_link():
    urls = google_sheet_export_urls(
        "https://docs.google.com/spreadsheets/u/0/d/example/edit?gid=123#gid=123"
    )

    assert urls == [
        "https://docs.google.com/spreadsheets/d/example/export?format=xlsx",
        "https://docs.google.com/spreadsheets/d/example/export?format=csv&gid=123",
    ]


def test_import_link_falls_back_to_csv_when_google_xlsx_returns_html(client, auth_headers, monkeypatch):
    from app.routers import inventory as inventory_router

    calls = []

    class FakeResponse:
        def __init__(self, content, content_type):
            self.content = content
            self.headers = {"content-type": content_type}

        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url):
            calls.append(url)
            if url.endswith("format=xlsx"):
                return FakeResponse(b"<!doctype html><html><body>Export warming up</body></html>", "text/html")
            assert url == "https://docs.google.com/spreadsheets/d/example/export?format=csv&gid=987654321"
            return FakeResponse(CSV_CONTENT.encode("utf-8"), "text/csv")

    monkeypatch.setattr(inventory_router.httpx, "AsyncClient", FakeAsyncClient)

    resp = client.post(
        "/api/v1/inventory/import",
        json={"url": "https://docs.google.com/spreadsheets/d/example/edit?usp=sharing#gid=987654321"},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["created"] == 2
    assert data["rows_importable"] == 2
    assert calls == [
        "https://docs.google.com/spreadsheets/d/example/export?format=xlsx",
        "https://docs.google.com/spreadsheets/d/example/export?format=csv&gid=987654321",
    ]


def test_import_csv_detects_header_after_title_row(client, auth_headers):
    csv_content = """Inventory Upload
Generated from seller worksheet

Product Name,Brand,SKU,Category,Cost,List Price,Qty,Image URL,Condition
Jordan 4 Military Blue,Nike,J4-MB-10,Sneakers,$120.00,$260.00,2,https://example.com/j4.jpg,New
"""

    resp = client.post(
        "/api/v1/inventory/import/file",
        files={"file": ("inventory.csv", csv_content, "text/csv")},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["created"] == 1
    assert data["sample_items"][0]["name"] == "Jordan 4 Military Blue"


def test_import_link_rejects_html_download(client, auth_headers, monkeypatch):
    from app.routers import inventory as inventory_router

    class FakeResponse:
        headers = {"content-type": "text/html"}
        content = b"<!doctype html><html><body>Sign in</body></html>"

        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url):
            return FakeResponse()

    monkeypatch.setattr(inventory_router.httpx, "AsyncClient", FakeAsyncClient)

    resp = client.post(
        "/api/v1/inventory/import",
        json={"url": "https://docs.google.com/spreadsheets/d/example/edit?usp=sharing"},
        headers=auth_headers,
    )

    assert resp.status_code == 400
    assert "web page instead of spreadsheet data" in resp.json()["detail"]
