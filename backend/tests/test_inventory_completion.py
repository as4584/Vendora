"""Completion coverage for inventory pricing, photo, and URL safety paths."""
from decimal import Decimal
import socket

import httpx
import pytest
from fastapi import HTTPException

from app.models.inventory import InventoryItem
from app.routers import inventory as inventory_router


def _item(db, user, **overrides):
    values = {
        "user_id": user.id,
        "name": "Coverage item",
        "quantity": 1,
        "status": "in_stock",
        "source": "manual",
    }
    values.update(overrides)
    model = InventoryItem(**values)
    db.add(model)
    db.commit()
    db.refresh(model)
    return model


class TestMarketAndPricing:
    def test_market_price_without_upc_and_with_empty_provider_results(
        self, client, auth_headers, monkeypatch
    ):
        no_upc = client.get("/api/v1/inventory/market-price?query=NoUPC", headers=auth_headers)
        assert no_upc.status_code == 200

        responses = [
            type("Response", (), {"status_code": 503, "json": lambda self: {}})(),
            type("Response", (), {"status_code": 200, "json": lambda self: {"items": []}})(),
            type("Response", (), {"status_code": 200, "json": lambda self: {"items": [{"offers": []}]}})(),
        ]

        class FakeClient:
            def __init__(self, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def get(self, *args, **kwargs):
                return responses.pop(0)

        monkeypatch.setattr(inventory_router.httpx, "AsyncClient", FakeClient)
        for upc in ("status", "empty", "no-prices"):
            response = client.get(
                f"/api/v1/inventory/market-price?query=Nothing&upc={upc}",
                headers=auth_headers,
            )
            assert response.status_code == 200
            assert response.json()["sources"] == []

    def test_market_price_external_upc_and_internal_history(
        self, client, auth_headers, db, test_user, monkeypatch
    ):
        _item(
            db,
            test_user,
            name="Jordan Coverage Shoe",
            actual_sell_price=Decimal("175.00"),
            status="sold",
        )

        class Response:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "items": [{
                        "title": "Jordan Retail",
                        "brand": "Nike",
                        "category": "Shoes",
                        "images": ["one", "two", "three"],
                        "offers": [
                            {"price": "200.00"},
                            {"price": 220},
                            {"price": 0},
                            {},
                        ],
                    }]
                }

        class FakeClient:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def get(self, *args, **kwargs):
                return Response()

        monkeypatch.setattr(inventory_router.httpx, "AsyncClient", FakeClient)
        response = client.get(
            "/api/v1/inventory/market-price?query=Jordan%20Coverage&upc=012345",
            headers=auth_headers,
        )
        assert response.status_code == 200
        body = response.json()
        assert body["product_info"]["name"] == "Jordan Retail"
        assert body["product_info"]["title"] == "Jordan Retail"
        assert body["product_info"]["images"] == ["one", "two"]
        assert {source["source"] for source in body["sources"]} == {"retail", "vendora_history"}
        assert all(source["price"] for source in body["sources"])
        assert body["internal_history"]["sample_count"] == 1

    def test_market_price_gracefully_handles_upc_failures_and_empty_results(
        self, client, auth_headers, monkeypatch
    ):
        class FailingClient:
            def __init__(self, **kwargs):
                pass

            async def __aenter__(self):
                raise httpx.ConnectError("offline")

            async def __aexit__(self, *args):
                return False

        monkeypatch.setattr(inventory_router.httpx, "AsyncClient", FailingClient)
        response = client.get(
            "/api/v1/inventory/market-price?query=Unknown&upc=999",
            headers=auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["product_info"] is None
        assert response.json()["sources"] == []

    def test_pricing_suggestion_name_category_margin_and_no_data(
        self, client, auth_headers, db, test_user
    ):
        name_history = _item(
            db,
            test_user,
            name="Shared Product Name sold",
            category="history-category",
            actual_sell_price=Decimal("90.00"),
            status="sold",
        )
        target_name = _item(
            db,
            test_user,
            name="Shared Product Name target",
            category="different-category",
            buy_price=Decimal("10.00"),
        )
        name_response = client.get(
            f"/api/v1/inventory/{target_name.id}/pricing-suggestion",
            headers=auth_headers,
        )
        assert name_response.status_code == 200
        assert name_response.json()["suggested_price"] == 90.0
        assert name_response.json()["confidence"] == "high"
        assert "similar items" in name_response.json()["reason"]

        _item(
            db,
            test_user,
            name="Unrelated sold item",
            category="category-only",
            actual_sell_price=Decimal("75.00"),
            status="sold",
        )
        category_target = _item(
            db,
            test_user,
            name="Category target unique",
            category="category-only",
            buy_price=Decimal("20.00"),
        )
        category_response = client.get(
            f"/api/v1/inventory/{category_target.id}/pricing-suggestion",
            headers=auth_headers,
        ).json()
        assert category_response["suggested_price"] == 75.0
        assert category_response["basis"] == "category_average"
        assert "category average" in category_response["reason"]

        margin_target = _item(
            db,
            test_user,
            name="Margin only target",
            category=None,
            buy_price=Decimal("100.00"),
            expected_sell_price=Decimal("140.00"),
        )
        margin_response = client.get(
            f"/api/v1/inventory/{margin_target.id}/pricing-suggestion",
            headers=auth_headers,
        ).json()
        assert margin_response["suggested_price"] == 130.0
        assert margin_response["basis"] == "cost_margin"
        assert margin_response["current_expected"] == 140.0

        empty_target = _item(
            db,
            test_user,
            name="No pricing evidence",
            category=None,
            buy_price=None,
        )
        empty_response = client.get(
            f"/api/v1/inventory/{empty_target.id}/pricing-suggestion",
            headers=auth_headers,
        ).json()
        assert empty_response["suggested_price"] is None
        assert empty_response["basis"] == "insufficient_data"
        assert "Add more sales data" in empty_response["reason"]

    def test_photo_update_sets_each_side(self, client, auth_headers):
        created = client.post(
            "/api/v1/inventory",
            json={"name": "Photo coverage"},
            headers=auth_headers,
        ).json()
        response = client.patch(
            f"/api/v1/inventory/{created['id']}/photos",
            json={
                "photo_front": "data:image/jpeg;base64,ZmFrZQ==",
                "photo_back": "https://example.com/back.jpg",
            },
            headers=auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["photo_front_url"].startswith("data:image/jpeg")
        assert response.json()["photo_back_url"] == "https://example.com/back.jpg"
        front_only = client.patch(
            f"/api/v1/inventory/{created['id']}/photos",
            json={"photo_front": "front-only"},
            headers=auth_headers,
        )
        assert front_only.status_code == 200
        back_only = client.patch(
            f"/api/v1/inventory/{created['id']}/photos",
            json={"photo_back": "back-only"},
            headers=auth_headers,
        )
        assert back_only.status_code == 200


class TestImportNetworkSafetyCompletion:
    @pytest.mark.parametrize(
        "url",
        [
            "ftp://example.com/file.csv",
            "https://user:pass@example.com/file.csv",
            "https://localhost/file.csv",
            "https://service.internal/file.csv",
            "https://example.com:8443/file.csv",
            "http://127.0.0.1/file.csv",
        ],
    )
    def test_public_url_parts_rejects_unsafe_forms(self, url):
        with pytest.raises(HTTPException):
            inventory_router._public_url_parts(url)

    def test_public_url_parts_accepts_global_ip(self):
        assert inventory_router._public_url_parts("https://8.8.8.8/items.csv").hostname == "8.8.8.8"

    @pytest.mark.asyncio
    async def test_dns_resolution_error_is_translated(self, monkeypatch):
        def fail(*args, **kwargs):
            raise socket.gaierror("not found")

        monkeypatch.setattr(inventory_router.socket, "getaddrinfo", fail)
        with pytest.raises(HTTPException) as exc:
            await inventory_router._assert_public_dns("https://missing.example/file.csv")
        assert exc.value.status_code == 400

    def test_peer_validation_rejects_private_and_allows_absent_stream(self):
        class Stream:
            @staticmethod
            def get_extra_info(name):
                return ("127.0.0.1", 443)

        response = type("Response", (), {"extensions": {"network_stream": Stream()}})()
        with pytest.raises(HTTPException):
            inventory_router._assert_public_peer(response)
        inventory_router._assert_public_peer(type("Response", (), {"extensions": {}})())
        public_response = type("Response", (), {
            "extensions": {"network_stream": type("Stream", (), {"get_extra_info": lambda self, name: ("8.8.8.8", 443)})()}
        })()
        inventory_router._assert_public_peer(public_response)

    @pytest.mark.asyncio
    async def test_download_streaming_success(self, monkeypatch):
        async def allow_dns(url):
            return None

        monkeypatch.setattr(inventory_router, "_assert_public_dns", allow_dns)

        class Response:
            is_redirect = False
            extensions = {}
            headers = {"content-type": "text/csv"}

            async def aiter_bytes(self):
                yield b"a,b\n"
                yield b"1,2\n"

            def raise_for_status(self):
                return None

        class Context:
            async def __aenter__(self):
                return Response()

            async def __aexit__(self, *args):
                return False

        class Client:
            def stream(self, *args):
                return Context()

        content, _, _ = await inventory_router._download_public_content(Client(), "https://example.com/items.csv")
        assert content == b"a,b\n1,2\n"

    def test_host_validation_normalizes_google_and_regular_links(self):
        google = inventory_router._validate_import_host(
            "https://docs.google.com/spreadsheets/d/SHEET/edit?gid=1"
        )
        assert len(google) == 2
        regular = inventory_router._validate_import_host("https://example.com/items.csv")
        assert regular == ["https://example.com/items.csv"]

    @pytest.mark.asyncio
    async def test_dns_rejects_empty_and_private_results(self, monkeypatch):
        monkeypatch.setattr(inventory_router.socket, "getaddrinfo", lambda *args, **kwargs: [])
        with pytest.raises(HTTPException, match="public addresses"):
            await inventory_router._assert_public_dns("https://example.com/items.csv")
        monkeypatch.setattr(
            inventory_router.socket,
            "getaddrinfo",
            lambda *args, **kwargs: [(None, None, None, None, ("8.8.8.8", 443)), (None, None, None, None, ("127.0.0.1", 443))],
        )
        with pytest.raises(HTTPException, match="public addresses"):
            await inventory_router._assert_public_dns("https://example.com/items.csv")

    @pytest.mark.asyncio
    async def test_download_non_streaming_success_and_limits(self, monkeypatch):
        async def allow_dns(url):
            return None

        monkeypatch.setattr(inventory_router, "_assert_public_dns", allow_dns)

        class Response:
            is_redirect = False
            extensions = {}
            content = b"a,b\n1,2\n"
            headers = {"content-type": "text/csv"}

            def raise_for_status(self):
                return None

        class Client:
            async def get(self, url):
                return Response()

        content, content_type, final_url = await inventory_router._download_public_content(
            Client(), "https://example.com/items.csv"
        )
        assert content.startswith(b"a,b") and content_type == "text/csv"
        assert final_url.endswith("items.csv")

        Response.headers = {"content-length": "999"}
        with pytest.raises(HTTPException) as exc:
            await inventory_router._download_public_content(Client(), "https://example.com/items.csv", max_bytes=4)
        assert exc.value.status_code == 413

        Response.headers = {}
        with pytest.raises(HTTPException) as exc:
            await inventory_router._download_public_content(Client(), "https://example.com/items.csv", max_bytes=4)
        assert exc.value.status_code == 413

    @pytest.mark.asyncio
    async def test_download_rejects_invalid_and_excessive_redirects(self, monkeypatch):
        async def allow_dns(url):
            return None

        monkeypatch.setattr(inventory_router, "_assert_public_dns", allow_dns)

        class Redirect:
            is_redirect = True
            extensions = {}
            headers = {}

        class Context:
            async def __aenter__(self):
                return Redirect()

            async def __aexit__(self, *args):
                return False

        class Client:
            def stream(self, *args):
                return Context()

        with pytest.raises(HTTPException, match="invalid redirect"):
            await inventory_router._download_public_content(Client(), "https://example.com/items.csv")

        Redirect.headers = {"location": "/next.csv"}
        with pytest.raises(HTTPException, match="too many times"):
            await inventory_router._download_public_content(Client(), "https://example.com/items.csv")


class TestInventoryImportRouteEdges:
    class DummyClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

    @pytest.mark.parametrize("kind", ["status", "network"])
    def test_link_import_translates_download_errors(self, client, auth_headers, monkeypatch, kind):
        monkeypatch.setattr(inventory_router.httpx, "AsyncClient", self.DummyClient)

        async def fail(*args, **kwargs):
            if kind == "status":
                request = httpx.Request("GET", "https://example.com/items.csv")
                response = httpx.Response(418, request=request)
                raise httpx.HTTPStatusError("teapot", request=request, response=response)
            raise httpx.ConnectError("offline")

        monkeypatch.setattr(inventory_router, "_download_public_content", fail)
        response = client.post(
            "/api/v1/inventory/import",
            json={"url": "https://example.com/items.csv", "dry_run": True},
            headers=auth_headers,
        )
        assert response.status_code == 400
        expected = "HTTP 418" if kind == "status" else "Could not download"
        assert expected in response.json()["detail"]

    def test_link_import_discovers_an_alternate_sheet(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(inventory_router.httpx, "AsyncClient", self.DummyClient)
        monkeypatch.setattr(inventory_router, "_validate_import_host", lambda url: ["https://example.com/first"])
        calls = []

        async def download(_client, url, **kwargs):
            calls.append(url)
            if len(calls) == 1:
                return b"unrecognized", "text/csv", url
            if len(calls) == 2:
                return b"sheet metadata gid=42", "text/html", url
            return b"Product Name,SKU\nDiscovered Item,D-1\n", "text/csv", url

        real_import = inventory_router._import_inventory_content
        attempts = 0

        def import_content(**kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise HTTPException(status_code=400, detail="Could not find an inventory header row")
            return real_import(**kwargs)

        monkeypatch.setattr(inventory_router, "_download_public_content", download)
        monkeypatch.setattr(inventory_router, "_import_inventory_content", import_content)
        monkeypatch.setattr(
            inventory_router,
            "google_sheet_candidate_csv_urls",
            lambda url, html: ["https://example.com/first", "https://example.com/discovered.csv"],
        )
        response = client.post(
            "/api/v1/inventory/import",
            json={"url": "https://docs.google.com/spreadsheets/d/SHEET/edit", "dry_run": True},
            headers=auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["sample_items"][0]["name"] == "Discovered Item"
        assert calls[-1].endswith("discovered.csv")

    def test_link_import_propagates_non_discovery_parse_errors(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(inventory_router.httpx, "AsyncClient", self.DummyClient)

        async def download(_client, url, **kwargs):
            return b"bad", "text/csv", url

        monkeypatch.setattr(inventory_router, "_download_public_content", download)
        monkeypatch.setattr(
            inventory_router,
            "_import_inventory_content",
            lambda **kwargs: (_ for _ in ()).throw(HTTPException(status_code=422, detail="unsupported sheet")),
        )
        response = client.post(
            "/api/v1/inventory/import",
            json={"url": "https://example.com/items.csv", "dry_run": True},
            headers=auth_headers,
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "unsupported sheet"

    def test_dry_run_reports_tier_limit_and_csv_validation(self, client, auth_headers, monkeypatch):
        monkeypatch.setitem(inventory_router.TIER_LIMITS, "free", 0)
        response = client.post(
            "/api/v1/inventory/import/file?dry_run=true",
            files={"file": ("items.csv", b"Product Name,SKU\nLimited,L-1\n", "text/csv")},
            headers=auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["created"] == 0
        assert response.json()["skipped"] == 1
        assert "Tier limit" in response.json()["errors"][0]["message"]

        with pytest.raises(HTTPException, match="no header"):
            inventory_router._parse_csv_bytes(b"")
        mapped, error = inventory_router._coerce_row({"name": "Bad", "quantity": "many"}, {"name": "name", "quantity": "quantity"})
        assert mapped == {} and "quantity" in error

    def test_import_matches_existing_upc_and_skips_unusable_rows(self, client, auth_headers):
        existing = client.post(
            "/api/v1/inventory",
            json={"name": "Existing UPC", "upc": "123456789", "quantity": 1},
            headers=auth_headers,
        ).json()
        response = client.post(
            "/api/v1/inventory/import/file?dry_run=true",
            files={"file": ("items.csv", b"Product Name,UPC\nUpdated UPC,123456789\n", "text/csv")},
            headers=auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["updated"] == 1

        skipped = client.post(
            "/api/v1/inventory/import/file?dry_run=true",
            files={"file": ("empty.csv", b"Product Name,Notes\n,orphan row\n", "text/csv")},
            headers=auth_headers,
        )
        assert skipped.status_code == 200
        assert skipped.json()["skipped"] == 1

        existing_sku = client.post(
            "/api/v1/inventory",
            json={"name": "Existing SKU", "sku": "SKU-MATCH", "quantity": 1},
            headers=auth_headers,
        ).json()
        sku_match = client.post(
            "/api/v1/inventory/import/file?dry_run=true",
            files={"file": ("sku.csv", b"Product Name,UPC,SKU\nSKU update,unmatched,SKU-MATCH\n", "text/csv")},
            headers=auth_headers,
        )
        assert sku_match.status_code == 200
        assert sku_match.json()["updated"] == 1

    def test_import_samples_are_capped_at_five(self, client, auth_headers):
        rows = "Product Name,SKU\n" + "".join(f"Item {i},CAP-{i}\n" for i in range(7))
        response = client.post(
            "/api/v1/inventory/import/file?dry_run=true",
            files={"file": ("many.csv", rows.encode(), "text/csv")},
            headers=auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["rows_importable"] == 7
        assert len(response.json()["sample_items"]) == 5

    def test_header_discovery_without_candidates_propagates_error(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(inventory_router.httpx, "AsyncClient", self.DummyClient)

        async def download(_client, url, **kwargs):
            return b"foo,bar\nx,y\n", "text/csv", url

        monkeypatch.setattr(inventory_router, "_download_public_content", download)
        monkeypatch.setattr(inventory_router, "google_sheet_candidate_csv_urls", lambda *args: [])
        response = client.post(
            "/api/v1/inventory/import",
            json={"url": "https://example.com/items.csv", "dry_run": True},
            headers=auth_headers,
        )
        assert response.status_code == 400
        assert "Could not find an inventory header row" in response.json()["detail"]

    def test_header_discovery_tolerates_metadata_download_failure(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(inventory_router.httpx, "AsyncClient", self.DummyClient)
        calls = 0

        async def download(_client, url, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return b"foo,bar\nx,y\n", "text/csv", url
            raise HTTPException(status_code=400, detail="metadata unavailable")

        monkeypatch.setattr(inventory_router, "_download_public_content", download)
        monkeypatch.setattr(inventory_router, "google_sheet_candidate_csv_urls", lambda *args: [])
        response = client.post(
            "/api/v1/inventory/import",
            json={"url": "https://example.com/items.csv", "dry_run": True},
            headers=auth_headers,
        )
        assert response.status_code == 400
        assert "Could not find an inventory header row" in response.json()["detail"]

    def test_link_import_handles_empty_candidate_list(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(inventory_router.httpx, "AsyncClient", self.DummyClient)
        monkeypatch.setattr(inventory_router, "_validate_import_host", lambda url: [])
        response = client.post(
            "/api/v1/inventory/import",
            json={"url": "https://example.com/items.csv", "dry_run": True},
            headers=auth_headers,
        )
        assert response.status_code == 400
        assert response.json()["detail"] == "Could not download the spreadsheet link."
