"""GET /api/v1/inventory/{id}/last-sale: price a sale from your own history."""


def make_item(client, headers, **over):
    body = {"name": "Jordan 4 Bred", "sku": "FV5029-006", "quantity": 3, "expected_sell_price": "260.00", **over}
    r = client.post("/api/v1/inventory", json=body, headers=headers)
    assert r.status_code == 201
    return r.json()["id"]


def sell(client, headers, item_id, gross, qty=1):
    r = client.post(
        "/api/v1/transactions",
        json={"item_id": item_id, "method": "cash", "gross_amount": gross, "fee_amount": "0.00", "quantity": qty},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


def last(client, headers, item_id):
    r = client.get(f"/api/v1/inventory/{item_id}/last-sale", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def test_none_when_never_sold(client, auth_headers):
    assert last(client, auth_headers, make_item(client, auth_headers)) is None


def test_this_item_most_recent_sale_per_unit(client, auth_headers):
    item = make_item(client, auth_headers)
    sell(client, auth_headers, item, "250.00")
    sell(client, auth_headers, item, "480.00", qty=2)
    got = last(client, auth_headers, item)
    assert got["match"] == "this_item"
    assert got["unit_price"] == "240.00"
    assert got["quantity"] == 2


def test_falls_back_to_same_sku_then_same_name(client, auth_headers):
    old = make_item(client, auth_headers, sku="fv5029-006")
    sell(client, auth_headers, old, "275.00")
    fresh = make_item(client, auth_headers)
    assert last(client, auth_headers, fresh)["match"] == "same_sku"
    assert last(client, auth_headers, fresh)["unit_price"] == "275.00"

    named = make_item(client, auth_headers, name="Pokemon 151 Booster Bundle", sku=None)
    sell(client, auth_headers, named, "45.00")
    again = make_item(client, auth_headers, name="pokemon 151 booster bundle", sku=None)
    got = last(client, auth_headers, again)
    assert got["match"] == "same_name"
    assert got["unit_price"] == "45.00"


def test_refunded_sales_are_ignored(client, auth_headers):
    item = make_item(client, auth_headers)
    txn = sell(client, auth_headers, item, "250.00")
    r = client.post(f"/api/v1/transactions/{txn['id']}/refund", json={}, headers=auth_headers)
    assert r.status_code in (200, 201), r.text
    assert last(client, auth_headers, item) is None


def test_only_your_own_sales(client, auth_headers, second_auth_headers):
    mine = make_item(client, auth_headers)
    theirs = make_item(client, second_auth_headers)
    sell(client, second_auth_headers, theirs, "999.00")
    assert last(client, auth_headers, mine) is None
    r = client.get(f"/api/v1/inventory/{theirs}/last-sale", headers=auth_headers)
    assert r.status_code == 404
