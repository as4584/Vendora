# ruff: noqa: F811 - pytest fixtures imported from test_ebay_listing are redefined as params
"""One-tap eBay business-policy setup. All eBay HTTP is mocked (no real calls)."""
from tests.test_ebay_listing import FakeEbay, _list, fake, happy, item, token  # noqa: F401 - fixtures

SETUP = "/api/v1/integrations/ebay/policies/setup"
OVERVIEW = "/api/v1/integrations/ebay/policies"
OPTED = (200, {"programs": [{"programType": "SELLING_POLICY_MANAGEMENT"}]})
NOT_OPTED_GET = (400, {"errors": [{"errorId": 20403, "message": "User is not eligible for Business Policy."}]})


def empty(fake: FakeEbay, opted=True) -> FakeEbay:
    """Seller with no policies; creates succeed."""
    return (
        fake.on("GET", "/program/get_opted_in_programs", OPTED if opted else (200, {"programs": []}))
        .on("POST", "/program/opt_in", (200, None))
        .on("GET", "/sell/account/v1/fulfillment_policy", (200, {"fulfillmentPolicies": []}))
        .on("GET", "/sell/account/v1/payment_policy", (200, {"paymentPolicies": []}))
        .on("GET", "/sell/account/v1/return_policy", (200, {"returnPolicies": []}))
        .on("POST", "/sell/account/v1/fulfillment_policy", (201, {"fulfillmentPolicyId": "F9", "name": "Resqlo default shipping"}))
        .on("POST", "/sell/account/v1/payment_policy", (201, {"paymentPolicyId": "P9", "name": "Resqlo default payment"}))
        .on("POST", "/sell/account/v1/return_policy", (201, {"returnPolicyId": "R9", "name": "Resqlo default returns"}))
    )


def _setup(client, headers, **body):
    return client.post(SETUP, json=body, headers=headers)


class TestOptIn:
    def test_already_opted_in_skips_opt_in(self, client, auth_headers, token, fake):
        empty(fake)
        r = _setup(client, auth_headers)
        assert r.status_code == 200, r.text
        assert r.json()["opt_in"] == "already"
        assert not any("opt_in" in p for p in fake.paths("POST"))

    def test_opt_in_succeeds(self, client, auth_headers, token, fake):
        empty(fake, opted=False)
        r = _setup(client, auth_headers)
        assert r.status_code == 200, r.text
        assert r.json()["opt_in"] == "opted_in"
        assert fake.body("POST", "/program/opt_in") == {"programType": "SELLING_POLICY_MANAGEMENT"}

    def test_opt_in_already_error_is_success(self, client, auth_headers, token, fake):
        empty(fake, opted=False).on(
            "POST", "/program/opt_in", (409, {"errors": [{"errorId": 1, "message": "User is already opted in"}]})
        )
        r = _setup(client, auth_headers)
        assert r.status_code == 200 and r.json()["opt_in"] == "already"

    def test_opt_in_pending_gives_try_again(self, client, auth_headers, token, fake):
        empty(fake, opted=False)
        for path in ("fulfillment_policy", "payment_policy", "return_policy"):
            fake.on("POST", f"/sell/account/v1/{path}", NOT_OPTED_GET)
        r = _setup(client, auth_headers)
        assert r.status_code == 409
        d = r.json()["detail"]
        assert d["error"] == "ebay_policies_pending"
        assert "try again" in d["message"] and d["retry_after_seconds"] == 60

    def test_opt_in_hard_failure(self, client, auth_headers, token, fake):
        empty(fake, opted=False).on(
            "POST", "/program/opt_in", (400, {"errors": [{"errorId": 2, "message": "Account restricted"}]})
        )
        r = _setup(client, auth_headers)
        assert r.status_code == 409
        d = r.json()["detail"]
        assert d["error"] == "ebay_opt_in_failed" and "Account restricted" in d["message"]


class TestCreate:
    def test_creates_all_defaults(self, client, auth_headers, token, fake):
        empty(fake)
        r = _setup(client, auth_headers)
        assert r.status_code == 200, r.text
        p = r.json()["policies"]
        assert {k: v["id"] for k, v in p.items()} == {"fulfillment": "F9", "payment": "P9", "return": "R9"}
        assert all(v["created"] for v in p.values())

        f = fake.body("POST", "/sell/account/v1/fulfillment_policy")
        assert f["name"] == "Resqlo default shipping" and f["marketplaceId"] == "EBAY_US"
        assert f["categoryTypes"] == [{"name": "ALL_EXCLUDING_MOTORS_VEHICLES"}]
        assert f["handlingTime"] == {"value": 2, "unit": "DAY"}
        svc = f["shippingOptions"][0]["shippingServices"][0]
        assert svc["shippingServiceCode"] == "USPSPriority" and svc["shippingCarrierCode"] == "USPS"
        assert svc["freeShipping"] is False and svc["shippingCost"] == {"value": "12.00", "currency": "USD"}

        pay = fake.body("POST", "/sell/account/v1/payment_policy")
        assert pay["immediatePay"] is True and "paymentMethods" not in pay

        ret = fake.body("POST", "/sell/account/v1/return_policy")
        assert ret["returnsAccepted"] is True and ret["returnPeriod"] == {"value": 30, "unit": "DAY"}
        assert ret["returnShippingCostPayer"] == "BUYER" and ret["refundMethod"] == "MONEY_BACK"

    def test_reuses_existing(self, client, auth_headers, token, fake):
        empty(fake).on(
            "GET", "/sell/account/v1/payment_policy",
            (200, {"paymentPolicies": [{"paymentPolicyId": "P1", "name": "Mine"}]}),
        )
        r = _setup(client, auth_headers)
        assert r.status_code == 200
        pay = r.json()["policies"]["payment"]
        assert pay == {"id": "P1", "name": "Mine", "label": "payment", "created": False}
        assert "/sell/account/v1/payment_policy" not in fake.paths("POST")
        assert "/sell/account/v1/fulfillment_policy" in fake.paths("POST")

    def test_all_exist_is_noop(self, client, auth_headers, token, fake):
        happy(fake).on("GET", "/program/get_opted_in_programs", OPTED)
        r = _setup(client, auth_headers)
        assert r.status_code == 200
        assert fake.paths("POST") == []

    def test_partial_failure_keeps_created(self, client, auth_headers, token, fake):
        empty(fake).on(
            "POST", "/sell/account/v1/return_policy",
            (400, {"errors": [{"errorId": 20200, "message": "Invalid return period"}]}),
        )
        r = _setup(client, auth_headers)
        assert r.status_code == 409
        d = r.json()["detail"]
        assert d["error"] == "ebay_policy_setup_incomplete"
        assert d["failed"] == {"return": "Invalid return period"}
        assert set(d["policies"]) == {"fulfillment", "payment"}
        # Retry only creates what is still missing.
        fake.on("GET", "/sell/account/v1/fulfillment_policy", (200, {"fulfillmentPolicies": [{"fulfillmentPolicyId": "F9"}]}))
        fake.on("GET", "/sell/account/v1/payment_policy", (200, {"paymentPolicies": [{"paymentPolicyId": "P9"}]}))
        fake.on("POST", "/sell/account/v1/return_policy", (201, {"returnPolicyId": "R9"}))
        fake.calls.clear()
        r = _setup(client, auth_headers)
        assert r.status_code == 200
        assert fake.paths("POST") == ["/sell/account/v1/return_policy"]

    def test_missing_id_in_response_is_failure(self, client, auth_headers, token, fake):
        empty(fake).on("POST", "/sell/account/v1/payment_policy", (201, {}))
        d = _setup(client, auth_headers).json()["detail"]
        assert "payment" in d["failed"]

    def test_read_5xx_is_failure(self, client, auth_headers, token, fake):
        empty(fake).on("GET", "/sell/account/v1/return_policy", (503, {"errors": []}))
        d = _setup(client, auth_headers).json()["detail"]
        assert "return" in d["failed"]

    def test_overrides_free_shipping_no_returns(self, client, auth_headers, token, fake):
        empty(fake)
        r = _setup(client, auth_headers, free_shipping=True, returns_accepted=False)
        assert r.status_code == 200
        svc = fake.body("POST", "/sell/account/v1/fulfillment_policy")["shippingOptions"][0]["shippingServices"][0]
        assert svc["freeShipping"] is True and svc["shippingCost"]["value"] == "0.00"
        ret = fake.body("POST", "/sell/account/v1/return_policy")
        assert ret["returnsAccepted"] is False and "returnPeriod" not in ret

    def test_override_flat_cost(self, client, auth_headers, token, fake):
        empty(fake)
        assert _setup(client, auth_headers, flat_shipping_cost="8.5").status_code == 200
        svc = fake.body("POST", "/sell/account/v1/fulfillment_policy")["shippingOptions"][0]["shippingServices"][0]
        assert svc["shippingCost"]["value"] == "8.50"

    def test_invalid_cost_rejected(self, client, auth_headers, token, fake):
        assert _setup(client, auth_headers, flat_shipping_cost="-1").status_code == 422

    def test_listing_picks_up_created_policies(self, client, auth_headers, token, item, fake):
        happy(fake)
        fake.on("GET", "/sell/account/v1/fulfillment_policy", (200, {"fulfillmentPolicies": [{"fulfillmentPolicyId": "F9"}]}))
        assert _list(client, auth_headers, item).status_code == 201
        assert fake.body("POST", "/sell/inventory/v1/offer")["listingPolicies"]["fulfillmentPolicyId"] == "F9"


class TestOverviewAndAuth:
    def test_overview_missing(self, client, auth_headers, token, fake):
        empty(fake).on("GET", "/sell/account/v1/payment_policy", (200, {"paymentPolicies": [{"paymentPolicyId": "P1", "name": "Mine"}]}))
        r = client.get(OVERVIEW, headers=auth_headers)
        assert r.status_code == 200
        d = r.json()
        assert d["opted_in"] is True and d["ready"] is False
        assert d["missing"] == ["shipping", "return"]
        assert d["policies"]["payment"]["id"] == "P1" and d["policies"]["fulfillment"] is None

    def test_overview_not_opted_in(self, client, auth_headers, token, fake):
        for path in ("fulfillment_policy", "payment_policy", "return_policy"):
            fake.on("GET", f"/sell/account/v1/{path}", NOT_OPTED_GET)
        d = client.get(OVERVIEW, headers=auth_headers).json()
        assert d["opted_in"] is False and len(d["missing"]) == 3

    def test_overview_ready(self, client, auth_headers, token, fake):
        happy(fake)
        d = client.get(OVERVIEW, headers=auth_headers).json()
        assert d["ready"] is True and d["missing"] == []

    def test_requires_auth(self, client, fake):
        assert client.get(OVERVIEW).status_code in (401, 403)
        assert client.post(SETUP, json={}).status_code in (401, 403)

    def test_not_connected(self, client, auth_headers, fake):
        r = _setup(client, auth_headers)
        assert r.status_code == 409 and r.json()["detail"]["error"] == "ebay_not_connected"

    def test_other_user_uses_own_token(self, client, second_auth_headers, token, fake):
        # The second user has no eBay token; the first user's token must never be used.
        empty(fake)
        r = _setup(client, second_auth_headers)
        assert r.status_code == 409 and r.json()["detail"]["error"] == "ebay_not_connected"
        assert fake.calls == []

    def test_missing_account_scope_needs_reconnect(self, client, auth_headers, db, token, fake):
        token.scopes = "https://api.ebay.com/oauth/api_scope/sell.inventory"
        db.flush()
        r = _setup(client, auth_headers)
        assert r.status_code == 409 and r.json()["detail"]["error"] == "ebay_reconnect_required"

