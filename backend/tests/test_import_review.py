"""Import review: edit / discard previewed rows before committing."""
import csv
import io

from app.models.inventory import InventoryItem

PREVIEW = "/api/v1/inventory/imports/preview"


def _csv(rows: list[dict]) -> bytes:
    fields = sorted({k for r in rows for k in r})
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue().encode()


def _preview(client, headers, rows):
    resp = client.post(PREVIEW, files={"file": ("r.csv", _csv(rows), "text/csv")}, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _patch(client, headers, job_id, row_id, body):
    return client.patch(f"/api/v1/inventory/imports/{job_id}/rows/{row_id}", json=body, headers=headers)


def test_preview_rows_carry_ids(client, auth_headers):
    data = _preview(client, auth_headers, [{"name": "Dunk", "sku": "D-1"}])
    assert data["rows"][0]["id"]


def test_edit_fixes_error_row_and_commit_uses_edits(client, db, auth_headers):
    data = _preview(client, auth_headers, [
        {"name": "", "sku": "BAD-1", "quantity": "2"},
        {"name": "Keep me", "sku": "K-1", "quantity": "1"},
    ])
    job, (bad, keep) = data["job_id"], data["rows"]
    assert bad["action"] == "error"

    resp = _patch(client, auth_headers, job, bad["id"], {"data": {
        "name": "Fixed Jordan", "sku": "BAD-1", "quantity": "4", "buy_price": "$50.00",
        "expected_sell_price": "120", "size": "10", "color": "Black",
    }})
    assert resp.status_code == 200, resp.text
    fixed = resp.json()
    assert fixed["action"] == "create" and fixed["error_message"] is None
    assert fixed["mapped_data"]["buy_price"] == 50.0 and fixed["mapped_data"]["quantity"] == 4

    edited = _patch(client, auth_headers, job, keep["id"], {"data": {"name": "Renamed", "sku": "K-1"}})
    assert edited.json()["mapped_data"]["name"] == "Renamed"

    commit = client.post(f"/api/v1/inventory/imports/{job}/commit", headers=auth_headers).json()
    assert commit["rows_created"] == 2
    names = {i.name for i in db.query(InventoryItem).all()}
    assert {"Fixed Jordan", "Renamed"} <= names


def test_edit_applies_importer_validation(client, auth_headers):
    data = _preview(client, auth_headers, [{"name": "Dunk", "sku": "D-2"}])
    job, row = data["job_id"], data["rows"][0]
    for body, msg in [
        ({"name": ""}, "name"),
        ({"name": "Dunk", "quantity": "two"}, "quantity"),
        ({"name": "Dunk", "buy_price": "abc"}, "buy_price"),
        ({"name": "Dunk", "quantity": "-1"}, "negative"),
    ]:
        out = _patch(client, auth_headers, job, row["id"], {"data": body}).json()
        assert out["action"] == "error" and msg in out["error_message"], out
    # an error row is not imported
    commit = client.post(f"/api/v1/inventory/imports/{job}/commit", headers=auth_headers).json()
    assert commit["rows_created"] == 0 and commit["rows_skipped"] == 1


def test_unknown_field_rejected(client, auth_headers):
    data = _preview(client, auth_headers, [{"name": "Dunk"}])
    resp = _patch(client, auth_headers, data["job_id"], data["rows"][0]["id"],
                  {"data": {"name": "x", "user_id": "evil"}})
    assert resp.status_code == 422


def test_discard_and_undo(client, db, auth_headers):
    data = _preview(client, auth_headers, [{"name": "A", "sku": "A-1"}, {"name": "B", "sku": "B-1"}])
    job, (a, b) = data["job_id"], data["rows"]
    assert _patch(client, auth_headers, job, a["id"], {"skip": True}).json()["action"] == "skip"
    assert _patch(client, auth_headers, job, b["id"], {"skip": True}).json()["action"] == "skip"
    assert _patch(client, auth_headers, job, b["id"], {"skip": False}).json()["action"] == "create"

    commit = client.post(f"/api/v1/inventory/imports/{job}/commit", headers=auth_headers).json()
    assert commit["rows_created"] == 1 and commit["rows_skipped"] == 1
    assert [i.name for i in db.query(InventoryItem).all()] == ["B"]


def test_edit_sku_to_existing_item_becomes_update(client, auth_headers):
    client.post("/api/v1/inventory", json={"name": "Existing", "sku": "EX-1", "quantity": 1}, headers=auth_headers)
    data = _preview(client, auth_headers, [{"name": "New", "sku": "NEW-1"}])
    row = data["rows"][0]
    assert row["action"] == "create"
    out = _patch(client, auth_headers, data["job_id"], row["id"], {"data": {"name": "New", "sku": "ex-1"}}).json()
    assert out["action"] == "update" and out["inventory_item_id"]


def test_committed_job_rows_are_frozen(client, auth_headers):
    data = _preview(client, auth_headers, [{"name": "A"}])
    job, row = data["job_id"], data["rows"][0]
    client.post(f"/api/v1/inventory/imports/{job}/commit", headers=auth_headers)
    assert _patch(client, auth_headers, job, row["id"], {"skip": True}).status_code == 400
    # commit stays idempotent
    assert client.post(f"/api/v1/inventory/imports/{job}/commit", headers=auth_headers).status_code == 400


def test_other_user_cannot_edit_row(client, auth_headers, second_auth_headers):
    data = _preview(client, auth_headers, [{"name": "A"}])
    resp = _patch(client, second_auth_headers, data["job_id"], data["rows"][0]["id"], {"skip": True})
    assert resp.status_code == 404
    other = _preview(client, second_auth_headers, [{"name": "B"}])
    # row from another job (owned by the caller) cannot be reached through this job
    resp = _patch(client, auth_headers, data["job_id"], other["rows"][0]["id"], {"skip": True})
    assert resp.status_code == 404
