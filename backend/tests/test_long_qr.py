"""QR codes holding long URLs must scan, save and pop up again like any barcode."""
from app.services.barcode_rules import fit_code

URL_A = "https://shop.example.com/products/" + "a" * 120 + "?variant=1"
URL_B = "https://shop.example.com/products/" + "a" * 120 + "?variant=2"


def test_fit_code_is_stable_and_distinct():
    assert fit_code("SHORT") == "SHORT"
    assert len(fit_code(URL_A)) == 50
    assert fit_code(URL_A) == fit_code(URL_A)
    assert fit_code(URL_A) != fit_code(URL_B)


def test_long_qr_learn_then_lookup(client, auth_headers):
    learn = client.post("/api/v1/scan/learn", json={"barcode": URL_A, "fields": {"name": "Store Tag Item"}}, headers=auth_headers)
    assert learn.status_code == 200, learn.text
    hit = client.get("/api/v1/scan/lookup", params={"barcode": URL_A}, headers=auth_headers)
    assert hit.status_code == 200 and hit.json()["match"] == "memory"
    assert hit.json()["fields"]["name"] == "Store Tag Item"
    miss = client.get("/api/v1/scan/lookup", params={"barcode": URL_B}, headers=auth_headers)
    assert miss.json()["match"] is None


def test_long_qr_saved_as_item_upc(client, auth_headers):
    resp = client.post("/api/v1/inventory", json={"name": "QR Item", "upc": URL_A, "quantity": 1}, headers=auth_headers)
    assert resp.status_code in (200, 201), resp.text
    assert len(resp.json()["upc"]) == 50
    found = client.get("/api/v1/scan/resolve", params={"code": URL_A}, headers=auth_headers)
    assert found.status_code == 200, found.text
    assert found.json()["item"]["name"] == "QR Item"
