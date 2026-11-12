"""Inventory list sort menu: GET /api/v1/inventory?sort=..."""
from datetime import datetime, timedelta, timezone

import pytest

from app.models.inventory import InventoryItem

ITEMS = [
    # name, buy, sell, qty, days old
    ("Bravo Dunk", "100.00", "150.00", 1, 10),
    ("alpha Samba", "40.00", "300.00", 5, 40),
    ("Charlie Box Logo", "200.00", "210.00", 2, 1),
    ("Delta No Price", "50.00", None, 3, 90),
]


@pytest.fixture
def seeded(client, auth_headers, db):
    now = datetime.now(timezone.utc)
    for name, buy, sell, qty, age in ITEMS:
        body = {"name": name, "buy_price": buy, "quantity": qty}
        if sell:
            body["expected_sell_price"] = sell
        r = client.post("/api/v1/inventory", json=body, headers=auth_headers)
        assert r.status_code == 201
        item = db.get(InventoryItem, r.json()["id"])
        item.created_at = now - timedelta(days=age)
    db.commit()


def names(client, auth_headers, sort):
    r = client.get(f"/api/v1/inventory?sort={sort}", headers=auth_headers)
    assert r.status_code == 200, r.text
    return [i["name"] for i in r.json()["items"]]


@pytest.mark.parametrize(
    "sort,expected",
    [
        ("newest", ["Charlie Box Logo", "Bravo Dunk", "alpha Samba", "Delta No Price"]),
        ("oldest", ["Delta No Price", "alpha Samba", "Bravo Dunk", "Charlie Box Logo"]),
        ("price_high", ["alpha Samba", "Charlie Box Logo", "Bravo Dunk", "Delta No Price"]),
        ("price_low", ["Bravo Dunk", "Charlie Box Logo", "alpha Samba", "Delta No Price"]),
        ("profit", ["alpha Samba", "Bravo Dunk", "Charlie Box Logo", "Delta No Price"]),
        ("qty", ["alpha Samba", "Delta No Price", "Charlie Box Logo", "Bravo Dunk"]),
        ("name", ["alpha Samba", "Bravo Dunk", "Charlie Box Logo", "Delta No Price"]),
    ],
)
def test_sort_orders(client, auth_headers, seeded, sort, expected):
    assert names(client, auth_headers, sort) == expected


def test_default_is_newest(client, auth_headers, seeded):
    r = client.get("/api/v1/inventory", headers=auth_headers)
    assert [i["name"] for i in r.json()["items"]][0] == "Charlie Box Logo"


def test_unknown_sort_rejected(client, auth_headers):
    r = client.get("/api/v1/inventory?sort=drop_table", headers=auth_headers)
    assert r.status_code == 422


def test_pages_never_overlap_on_ties(client, auth_headers):
    for i in range(6):
        client.post("/api/v1/inventory", json={"name": f"Same {i}", "quantity": 1}, headers=auth_headers)
    seen = []
    for page in (1, 2, 3):
        r = client.get(f"/api/v1/inventory?sort=qty&per_page=2&page={page}", headers=auth_headers)
        seen += [i["id"] for i in r.json()["items"]]
    assert len(seen) == len(set(seen)) == 6


def test_stale_filter_only_old_in_stock(client, auth_headers, seeded):
    r = client.get("/api/v1/inventory?min_age_days=30&sort=oldest", headers=auth_headers)
    assert [i["name"] for i in r.json()["items"]] == ["Delta No Price", "alpha Samba"]
