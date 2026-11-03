"""StockX pricing hint (Add stock) — mocked HTTP only."""
from tests.test_stockx_integration import (  # noqa: F401 - fixtures
    MARKET_PATH, PRODUCT, PRODUCTS, VARIANTS, configured, fake, token,
)

URL = "/api/v1/integrations/stockx/quote"
NAME = "Air Jordan 1 Chicago Lost and Found"


def test_quote_returns_market_for_size(client, auth_headers, token, fake):  # noqa: F811
    fake.on("GET", "/catalog/search", (200, {"products": PRODUCTS}))
    fake.on("GET", f"/catalog/products/{PRODUCT}/variants", (200, VARIANTS))
    fake.on("GET", MARKET_PATH, (200, {"lowestAskAmount": "260", "lastSaleAmount": "244"}))
    body = client.get(URL, params={"query": NAME, "size": "10"}, headers=auth_headers).json()
    assert body["product"]["product_id"] == PRODUCT
    assert body["market"]["last_sale"] == "244.00"
    assert body["market"]["lowest_ask"] == "260.00"


def test_quote_unknown_size_and_no_match(client, auth_headers, token, fake):  # noqa: F811
    fake.on("GET", "/catalog/search", (200, {"products": PRODUCTS}), (200, {"products": []}))
    fake.on("GET", f"/catalog/products/{PRODUCT}/variants", (200, VARIANTS))
    body = client.get(URL, params={"query": NAME, "size": "15"}, headers=auth_headers).json()
    assert body["product"]["product_id"] == PRODUCT and body["market"] is None
    empty = client.get(URL, params={"query": "zzzz"}, headers=auth_headers).json()
    assert empty == {"product": None, "variant_id": None, "market": None}


def test_quote_api_error(client, auth_headers, token, fake):  # noqa: F811
    fake.on("GET", "/catalog/search", (500, {}))
    assert client.get(URL, params={"query": "abc"}, headers=auth_headers).status_code == 502
