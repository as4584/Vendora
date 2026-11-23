"""Spreadsheet imports must not fail for size: big CSVs, XLSX, and chunked uploads."""
import base64
import io

from openpyxl import Workbook

from app.routers import inventory as inventory_router

PREVIEW = "/api/v1/inventory/imports/preview"
UPLOADS = "/api/v1/inventory/imports/uploads"


def _big_csv(rows: int) -> bytes:
    lines = ["Product Name,SKU,Qty,Cost,Notes"]
    pad = "x" * 400
    lines += [f"Jordan 4 #{i},SKU-{i},1,120.00,{pad}" for i in range(rows)]
    return ("\n".join(lines) + "\n").encode()


def _xlsx(rows: list[list]) -> bytes:
    wb = Workbook()
    ws = wb.active
    for row in rows:
        ws.append(row)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def test_csv_over_old_5mb_limit_previews(client, auth_headers):
    content = _big_csv(15_000)  # ~6.6 MB, used to be rejected at 5 MB
    assert len(content) > 5 * 1024 * 1024
    resp = client.post(PREVIEW, files={"file": ("big.csv", content, "text/csv")}, headers=auth_headers)
    assert resp.status_code == 201, resp.text
    assert resp.json()["total_rows"] == 15_000


def test_xlsx_previews_instead_of_rejecting(client, auth_headers):
    content = _xlsx([["Product Name", "SKU", "Qty", "Cost"], ["Dunk Low", "DL-1", 2, 95.5]])
    resp = client.post(
        PREVIEW,
        files={"file": ("stock.xlsx", content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text
    row = resp.json()["rows"][0]
    assert row["action"] == "create"
    assert row["mapped_data"]["sku"] == "DL-1"
    assert row["mapped_data"]["quantity"] == 2


def test_cp1252_csv_previews(client, auth_headers):
    content = "Product Name,SKU\nCafé Dunk,CD-1\n".encode("cp1252")
    resp = client.post(PREVIEW, files={"file": ("w.csv", content, "text/csv")}, headers=auth_headers)
    assert resp.status_code == 201, resp.text
    assert resp.json()["rows"][0]["mapped_data"]["name"] == "Café Dunk"


def test_old_xls_gets_actionable_message(client, auth_headers):
    resp = client.post(PREVIEW, files={"file": ("old.xls", b"\xd0\xcf\x11\xe0", "application/vnd.ms-excel")},
                       headers=auth_headers)
    assert resp.status_code == 400
    assert "Save As" in resp.json()["detail"]


def test_unknown_extension_rejected(client, auth_headers):
    resp = client.post(PREVIEW, files={"file": ("a.pdf", b"%PDF", "application/pdf")}, headers=auth_headers)
    assert resp.status_code == 400


def _chunked(client, headers, content: bytes, filename: str, chunk: int):
    start = client.post(UPLOADS, json={"filename": filename, "size": len(content)}, headers=headers)
    assert start.status_code == 201, start.text
    upload_id = start.json()["upload_id"]
    for index, offset in enumerate(range(0, len(content), chunk)):
        part = base64.b64encode(content[offset:offset + chunk]).decode()
        resp = client.put(f"{UPLOADS}/{upload_id}", json={"index": index, "data": part}, headers=headers)
        assert resp.status_code == 200, resp.text
    return upload_id


def test_chunked_upload_previews_large_file(client, auth_headers):
    content = _big_csv(3_000)
    upload_id = _chunked(client, auth_headers, content, "big.csv", chunk=256 * 1024)
    resp = client.post(f"{UPLOADS}/{upload_id}/preview", json={"filename": "big.csv"}, headers=auth_headers)
    assert resp.status_code == 201, resp.text
    assert resp.json()["total_rows"] == 3_000
    # the temp file is consumed
    again = client.post(f"{UPLOADS}/{upload_id}/preview", json={"filename": "big.csv"}, headers=auth_headers)
    assert again.status_code == 404


def test_chunk_retry_is_idempotent_and_gaps_rejected(client, auth_headers):
    start = client.post(UPLOADS, json={"filename": "a.csv", "size": 10}, headers=auth_headers)
    upload_id = start.json()["upload_id"]
    first = {"index": 0, "data": base64.b64encode(b"Product Name\n").decode()}
    assert client.put(f"{UPLOADS}/{upload_id}", json=first, headers=auth_headers).json() == {"received": 1}
    assert client.put(f"{UPLOADS}/{upload_id}", json=first, headers=auth_headers).json() == {"received": 1}
    gap = {"index": 5, "data": base64.b64encode(b"x").decode()}
    assert client.put(f"{UPLOADS}/{upload_id}", json=gap, headers=auth_headers).status_code == 409
    bad = {"index": 1, "data": "!!not base64!!"}
    assert client.put(f"{UPLOADS}/{upload_id}", json=bad, headers=auth_headers).status_code == 400


def test_chunk_upload_guards(client, auth_headers, monkeypatch):
    assert client.put(f"{UPLOADS}/00000000-0000-0000-0000-000000000000",
                      json={"index": 0, "data": ""}, headers=auth_headers).status_code == 404
    assert client.post(f"{UPLOADS}/00000000-0000-0000-0000-000000000000/preview",
                       json={"filename": "a.csv"}, headers=auth_headers).status_code == 404
    huge = inventory_router.IMPORT_UPLOAD_MAX_BYTES + 1
    assert client.post(UPLOADS, json={"filename": "a.csv", "size": huge}, headers=auth_headers).status_code == 413

    monkeypatch.setattr(inventory_router, "IMPORT_UPLOAD_MAX_BYTES", 8)
    monkeypatch.setattr(inventory_router, "IMPORT_CHUNK_MAX_BYTES", 6)
    upload_id = client.post(UPLOADS, json={"filename": "a.csv", "size": 1}, headers=auth_headers).json()["upload_id"]
    too_big_chunk = {"index": 0, "data": base64.b64encode(b"1234567").decode()}
    assert client.put(f"{UPLOADS}/{upload_id}", json=too_big_chunk, headers=auth_headers).status_code == 413
    ok = {"index": 0, "data": base64.b64encode(b"12345").decode()}
    assert client.put(f"{UPLOADS}/{upload_id}", json=ok, headers=auth_headers).status_code == 200
    over = {"index": 1, "data": base64.b64encode(b"12345").decode()}
    assert client.put(f"{UPLOADS}/{upload_id}", json=over, headers=auth_headers).status_code == 413


def test_stale_uploads_are_swept(tmp_path, monkeypatch):
    import os
    monkeypatch.setattr(inventory_router, "IMPORT_UPLOAD_DIR", tmp_path)
    stale = tmp_path / "old.part"
    stale.write_bytes(b"x")
    os.utime(stale, (0, 0))
    fresh = tmp_path / "new.part"
    fresh.write_bytes(b"x")
    inventory_router._sweep_stale_uploads()
    assert not stale.exists() and fresh.exists()


def test_stringify_cell():
    from datetime import datetime
    assert inventory_router._stringify_cell(None) == ""
    assert inventory_router._stringify_cell(3.0) == "3"
    assert inventory_router._stringify_cell(datetime(2026, 1, 2)) == "2026-01-02"
    assert inventory_router._stringify_cell(datetime(2026, 1, 2, 3, 4)) == "2026-01-02T03:04:00"
