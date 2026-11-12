"""Smart inventory search: typos, sizes, nicknames, card grades, ranking."""

import pytest

from app.models.inventory import InventoryItem
from app.services import smart_search

API = "/api/v1/inventory"


def _sizes(*pairs):
    return {"variants": [{"size": s, "quantity": q} for s, q in pairs]}


@pytest.fixture()
def stock(db, test_user):
    rows = [
        dict(name="Air Jordan 4 Retro 'Black Cat'", sku="CU1110-010", color="Black", category="Sneakers",
             custom_attributes=_sizes(("9", 1), ("10", 2))),
        dict(name="Nike Dunk Low 'Panda'", sku="DD1391-100", color="White/Black", category="Sneakers",
             size="10.5"),
        dict(name="Air Jordan 1 Retro High OG 'Chicago Lost & Found'", sku="DZ5485-612", category="Sneakers",
             custom_attributes=_sizes(("11", 1), ("10", 0))),
        dict(name="Yeezy Boost 350 V2 'Onyx'", sku="HQ4540", category="Sneakers", size="9"),
        dict(name="New Balance 550 White Green", sku="BB550WT1", category="Sneakers", size="10"),
        dict(name="2023 Prizm Victor Wembanyama Rookie", sku="PRIZM-136", category="Trading Cards",
             custom_attributes={"grader": "PSA", "grade": "10", "player": "Victor Wembanyama", "year": "2023"},
             condition="PSA 10"),
        dict(name="2023 Prizm Victor Wembanyama Rookie", sku="PRIZM-136-RAW", category="Trading Cards",
             condition="Raw"),
        dict(name="Charizard ex 199/165 Pokemon 151", sku="SV3PT5-199", category="Trading Cards",
             condition="BGS 9.5"),
    ]
    for r in rows:
        db.add(InventoryItem(user_id=test_user.id, quantity=1, buy_price="10.00", **r))
    db.commit()


def _search(client, auth_headers, q, **params):
    r = client.get(API, params={"q": q, "per_page": 50, **params}, headers=auth_headers)
    assert r.status_code == 200, r.text
    return [i["name"] for i in r.json()["items"]]


@pytest.mark.parametrize(
    "q, expected_first",
    [
        ("jordon 4 blk cat", "Air Jordan 4 Retro 'Black Cat'"),          # typo + abbreviation
        ("aj4 black cat", "Air Jordan 4 Retro 'Black Cat'"),             # nickname
        ("pandas", "Nike Dunk Low 'Panda'"),                              # plural nickname
        ("dd1391", "Nike Dunk Low 'Panda'"),                              # partial SKU
        ("yzy onyx", "Yeezy Boost 350 V2 'Onyx'"),
        ("nb 550", "New Balance 550 White Green"),
        ("wemby prizm psa 10", "2023 Prizm Victor Wembanyama Rookie"),     # card + grade
        ("charizard bgs 9.5", "Charizard ex 199/165 Pokemon 151"),
        ("CU1110-010", "Air Jordan 4 Retro 'Black Cat'"),                 # exact SKU
    ],
)
def test_finds_what_sellers_type(client, auth_headers, stock, q, expected_first):
    names = _search(client, auth_headers, q)
    assert names and names[0] == expected_first, (q, names)


def test_size_filter_uses_in_stock_variants(client, auth_headers, stock):
    names = _search(client, auth_headers, "jordan sz 10")
    assert names == ["Air Jordan 4 Retro 'Black Cat'"]  # the Chicago size 10 is sold out


def test_size_forms(client, auth_headers, stock):
    assert _search(client, auth_headers, "dunk size 10.5") == ["Nike Dunk Low 'Panda'"]
    assert _search(client, auth_headers, "dunk 10.5") == ["Nike Dunk Low 'Panda'"]
    assert _search(client, auth_headers, "sz9") == ["Air Jordan 4 Retro 'Black Cat'", "Yeezy Boost 350 V2 'Onyx'"] or \
        set(_search(client, auth_headers, "sz9")) == {"Air Jordan 4 Retro 'Black Cat'", "Yeezy Boost 350 V2 'Onyx'"}


def test_grade_is_a_phrase(client, auth_headers, stock):
    names = _search(client, auth_headers, "wembanyama psa 10")
    assert names == ["2023 Prizm Victor Wembanyama Rookie"]
    raw = client.get(API, params={"q": "wembanyama raw"}, headers=auth_headers).json()["items"]
    assert [i["sku"] for i in raw] == ["PRIZM-136-RAW"]


def test_every_word_must_match(client, auth_headers, stock):
    assert _search(client, auth_headers, "jordan onyx") == []
    assert _search(client, auth_headers, "zzzz") == []


def test_pagination_and_filters_still_apply(client, auth_headers, stock):
    r = client.get(API, params={"q": "sneakers", "per_page": 2, "page": 2}, headers=auth_headers).json()
    assert r["total"] == 5 and r["pages"] == 3 and len(r["items"]) == 2
    assert _search(client, auth_headers, "jordan", status="sold") == []


def test_other_users_items_never_match(client, db, auth_headers, stock):
    from app.models.user import User

    other = User(email="other@example.com", password_hash="x", business_name="O")
    db.add(other)
    db.commit()
    db.add(InventoryItem(user_id=other.id, name="Air Jordan 4 Secret", quantity=1))
    db.commit()
    assert "Air Jordan 4 Secret" not in _search(client, auth_headers, "jordan 4")


def test_parse_units():
    q = smart_search.parse("AJ1 sz 10 psa 9 blk 10w")
    assert q.terms == ["jordan 1", "psa 9", "black"]
    assert q.sizes == {"10"}
    assert smart_search.parse("2023 prizm").loose_numbers == []  # years are not sizes
    assert smart_search.parse("").empty and smart_search.parse(None).empty
