"""Smart scan memory: learned only from the seller's own saves, corrections win."""
from app.models.inventory import InventoryItem
from app.routers.scan import normalize_barcode

API = "/api/v1/scan"
DUNK = {"name": "Nike Dunk Low Panda", "brand": "Nike", "style_code": "dd1391-100",
        "size": "10", "color": "White/Black", "buy_price": "110.00"}


def _learn(client, headers, barcode, fields):
    return client.post(f"{API}/learn", json={"barcode": barcode, "fields": fields}, headers=headers)


def _lookup(client, headers, barcode, style=None):
    params = {"barcode": barcode}
    if style:
        params["style_code"] = style
    return client.get(f"{API}/lookup", params=params, headers=headers).json()


class TestNormalize:
    def test_upc_read_as_ean13_is_the_same_code(self):
        assert normalize_barcode("0195866137738") == normalize_barcode("195866137738")

    def test_strips_spaces_and_dashes(self):
        assert normalize_barcode(" 1958-6613 7738 ") == "195866137738"


class TestScanMemory:
    def test_unknown_barcode_has_no_match(self, client, auth_headers):
        assert _lookup(client, auth_headers, "195866137738") == {
            "barcode": "195866137738", "match": None, "fields": {}, "times_seen": 0}

    def test_learned_barcode_fills_everything(self, client, auth_headers):
        assert _learn(client, auth_headers, "195866137738", DUNK).status_code == 200
        hit = _lookup(client, auth_headers, "0195866137738")
        assert hit["match"] == "memory"
        assert hit["fields"]["name"] == "Nike Dunk Low Panda"
        assert hit["fields"]["style_code"] == "DD1391-100"

    def test_correction_wins_next_time(self, client, auth_headers):
        _learn(client, auth_headers, "195866137738", DUNK)
        _learn(client, auth_headers, "195866137738", {**DUNK, "name": "Nike Dunk Low Retro White Black"})
        hit = _lookup(client, auth_headers, "195866137738")
        assert hit["fields"]["name"] == "Nike Dunk Low Retro White Black"
        assert hit["times_seen"] == 2

    def test_style_family_fills_all_but_size(self, client, auth_headers):
        _learn(client, auth_headers, "195866137738", DUNK)
        hit = _lookup(client, auth_headers, "195866137745", style="DD1391-100")
        assert hit["match"] == "style"
        assert hit["fields"]["name"] == "Nike Dunk Low Panda"
        assert "size" not in hit["fields"]

    def test_existing_inventory_upc_is_found(self, client, auth_headers, db, test_user):
        db.add(InventoryItem(user_id=test_user.id, name="Jordan 4 Bred", upc="0195866000001",
                             size="9", quantity=1, custom_attributes={"brand": "Jordan"}))
        db.commit()
        hit = _lookup(client, auth_headers, "195866000001")
        assert hit["match"] == "inventory"
        assert hit["fields"]["name"] == "Jordan 4 Bred"
        assert hit["fields"]["brand"] == "Jordan"

    def test_memory_is_private_per_account(self, client, auth_headers, db):
        from app.models.scan_memory import ScanMemory
        from app.models.user import User
        other = User(email="someone-else@example.com", password_hash="x")
        db.add(other)
        db.commit()
        db.add(ScanMemory(user_id=other.id, barcode="195866137738", fields={"name": "Theirs"}))
        db.commit()
        assert _lookup(client, auth_headers, "195866137738")["match"] is None

    def test_name_is_required_and_junk_keys_dropped(self, client, auth_headers):
        assert _learn(client, auth_headers, "195866137738", {"size": "10"}).status_code == 422
        body = _learn(client, auth_headers, "195866137738", {"name": "X", "evil": "y"}).json()
        assert body["fields"] == {"name": "X"}

    def test_download_and_forget(self, client, auth_headers):
        _learn(client, auth_headers, "195866137738", DUNK)
        rows = client.get(f"{API}/memory", headers=auth_headers).json()
        assert [r["barcode"] for r in rows] == ["195866137738"]
        assert client.delete(f"{API}/memory/195866137738", headers=auth_headers).status_code == 204
        assert client.delete(f"{API}/memory/195866137738", headers=auth_headers).status_code == 404

    def test_requires_login(self, client):
        assert client.get(f"{API}/lookup", params={"barcode": "12345678"}).status_code == 401
