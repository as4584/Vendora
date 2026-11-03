"""Smart Scan learns from imports and from a one-time inventory backfill,
without ever overwriting what the seller confirmed."""
import csv
import io
from decimal import Decimal

from app.models.inventory import InventoryItem
from app.models.scan_memory import ScanMemory

API = "/api/v1"


def _csv(rows):
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue().encode()


def _memory(db, user):
    return {m.barcode: m for m in db.query(ScanMemory).filter_by(user_id=user.id).all()}


def _preview_commit(client, headers, rows):
    preview = client.post(f"{API}/inventory/imports/preview",
                          files={"file": ("scan.csv", _csv(rows), "text/csv")}, headers=headers)
    assert preview.status_code == 201, preview.text
    resp = client.post(f"{API}/inventory/imports/{preview.json()['job_id']}/commit", headers=headers)
    assert resp.status_code == 200, resp.text


class TestImportTeachesScan:
    def test_preview_commit_creates_memory_for_barcoded_rows(self, client, auth_headers, db, test_user):
        _preview_commit(client, auth_headers, [
            {"name": "Dunk Low Panda", "sku": "DD1391-100", "upc": "0195866131234", "size": "10", "quantity": "1"},
            {"name": "No Barcode Tee", "sku": "TEE-1", "upc": "", "size": "M", "quantity": "1"},
        ])
        mem = _memory(db, test_user)
        assert list(mem) == ["195866131234"]  # EAN-13 leading zero normalized away
        assert mem["195866131234"].fields["name"] == "Dunk Low Panda"
        assert mem["195866131234"].fields["size"] == "10"

    def test_never_overwrites_seller_confirmed_memory(self, client, auth_headers, db, test_user):
        learned = client.post(f"{API}/scan/learn", json={
            "barcode": "195866131234", "fields": {"name": "Dunk Low Panda (corrected)", "size": "10.5"},
        }, headers=auth_headers)
        assert learned.status_code == 200
        _preview_commit(client, auth_headers, [
            {"name": "Dunk Low", "sku": "DD1391-100", "upc": "195866131234", "size": "10",
             "color": "White/Black", "quantity": "1"},
        ])
        db.expire_all()
        row = _memory(db, test_user)["195866131234"]
        assert row.fields["name"] == "Dunk Low Panda (corrected)"
        assert row.fields["size"] == "10.5"
        assert row.fields["color"] == "White/Black"  # gaps are filled
        assert row.times_seen == 1  # an import is not a scan

    def test_direct_file_import_teaches_too(self, client, auth_headers, db, test_user):
        resp = client.post(f"{API}/inventory/import/file?dry_run=false",
                           files={"file": ("inv.csv", _csv([
                               {"name": "Jordan 4 Bred", "upc": "196152345678", "size": "9", "quantity": "1"},
                           ]), "text/csv")}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert "196152345678" in _memory(db, test_user)

    def test_dry_run_teaches_nothing(self, client, auth_headers, db, test_user):
        client.post(f"{API}/inventory/import/file?dry_run=true",
                    files={"file": ("inv.csv", _csv([
                        {"name": "Jordan 4 Bred", "upc": "196152345678", "quantity": "1"},
                    ]), "text/csv")}, headers=auth_headers)
        assert _memory(db, test_user) == {}


class TestBackfill:
    def _item(self, db, user, name, upc, **kw):
        item = InventoryItem(user_id=user.id, name=name, upc=upc, quantity=1, **kw)
        db.add(item)
        db.commit()
        return item

    def test_backfill_is_idempotent_and_respects_confirmed(self, client, auth_headers, db, test_user):
        self._item(db, test_user, "Yeezy 350 Zebra", "123456789012", size="10", buy_price=Decimal("200.00"))
        self._item(db, test_user, "Cap", None)
        self._item(db, test_user, "Short code", "12")
        client.post(f"{API}/scan/learn", json={"barcode": "999999999999", "fields": {"name": "Confirmed"}},
                    headers=auth_headers)
        self._item(db, test_user, "Old name", "999999999999")

        first = client.post(f"{API}/scan/backfill", headers=auth_headers)
        assert first.status_code == 200, first.text
        assert first.json()["created"] == 1
        mem = _memory(db, test_user)
        assert mem["123456789012"].fields["name"] == "Yeezy 350 Zebra"
        assert mem["123456789012"].fields["buy_price"] == "200.00"
        assert mem["999999999999"].fields["name"] == "Confirmed"

        again = client.post(f"{API}/scan/backfill", headers=auth_headers).json()
        assert again["created"] == 0 and again["updated"] == 0
        assert db.query(ScanMemory).filter_by(user_id=test_user.id).count() == 2

    def test_deleted_items_are_ignored(self, client, auth_headers, db, test_user):
        from datetime import datetime, timezone
        self._item(db, test_user, "Gone", "555555555555", deleted_at=datetime.now(timezone.utc))
        assert client.post(f"{API}/scan/backfill", headers=auth_headers).json()["created"] == 0

    def test_requires_auth(self, client):
        assert client.post(f"{API}/scan/backfill").status_code in (401, 403)
