# ruff: noqa: F811 - pytest fixtures imported from test_ebay_listing are redefined as params
"""eBay insights: Finances fees/payouts, traffic, notifications, offers.

All eBay HTTP is mocked (httpx.MockTransport via tests.test_ebay_listing).
"""
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import patch

from app.models.ebay_insights import EbayListingTraffic, EbayOrderFees
from app.models.inventory import InventoryExternalLink, InventoryStockLedger
from app.models.provider import ProviderWebhookEvent
from app.models.transaction import Transaction
from app.services import ebay_insights
from app.services.ebay import ebay_service
from tests.ebay_signing import _fake_fetch, sign_header
from tests.test_ebay_listing import FakeEbay, fake, item, token  # noqa: F401 - fixtures

API = "/api/v1/integrations/ebay"


def _listed(db, item, qty=1, price="250.00", listing_id="LIST1"):
    link = InventoryExternalLink(
        inventory_item_id=item.id, user_id=item.user_id, provider="ebay", external_id=str(item.id),
        external_sku=str(item.id), offer_id="OF1", listing_id=listing_id, listing_status="active",
        listed_price=Decimal(price), listed_quantity=qty,
    )
    db.add(link)
    db.flush()
    return link


def _txn(db, user, order_id="O-1", gross="250.00"):
    t = Transaction(user_id=user.id, method="other", status="completed", gross_amount=Decimal(gross),
                    fee_amount=Decimal("0"), net_amount=Decimal(gross), external_reference_id=order_id,
                    source="ebay")
    db.add(t)
    db.flush()
    return t


SALE = {
    "transactionType": "SALE", "orderId": "O-1", "payoutId": "P-1",
    "amount": {"value": "216.25", "currency": "USD"},
    "orderLineItems": [{"lineItemId": "L-1", "marketplaceFees": [
        {"feeType": "FINAL_VALUE_FEE", "amount": {"value": "32.50"}},
        {"feeType": "FINAL_VALUE_FEE_FIXED_PER_ORDER", "amount": {"value": "0.40"}},
        {"feeType": "INTERNATIONAL_FEE", "amount": {"value": "0.85"}},
    ]}],
}
LABEL = {"transactionType": "SHIPPING_LABEL", "orderId": "O-1", "payoutId": "P-1", "amount": {"value": "9.10"}}
AD = {"transactionType": "NON_SALE_CHARGE", "feeType": "AD_FEE", "payoutId": "P-1",
      "references": [{"referenceType": "ORDER_ID", "referenceId": "O-1"}], "amount": {"value": "5.00"}}


class TestFinances:
    def test_classify_and_aggregate(self):
        assert ebay_insights.classify_fee("AD_FEE") == "ad_fee"
        assert ebay_insights.classify_fee("FINAL_VALUE_FEE_FIXED_PER_ORDER") == "final_value_fee"
        assert ebay_insights.classify_fee("SHIPPING_LABEL") == "shipping_label"
        assert ebay_insights.classify_fee("REGULATORY_OPERATING_FEE") == "other_fees"
        orders = ebay_insights.aggregate_fees([SALE, LABEL, AD, {"transactionType": "REFUND", "orderId": "O-1"},
                                               {"transactionType": "SALE"}])
        b = orders["O-1"]
        assert b["final_value_fee"] == Decimal("32.90") and b["other_fees"] == Decimal("0.85")
        assert b["shipping_label"] == Decimal("9.10") and b["ad_fee"] == Decimal("5.00")
        assert b["total_fees"] == Decimal("47.85") and b["payout_id"] == "P-1"
        assert b["lines"][0]["fees"]["FINAL_VALUE_FEE"] == "32.50"

    async def test_sync_sets_fees_net_and_reconciles_payout(self, client, auth_headers, db, test_user, token, fake):
        txn = _txn(db, test_user)
        fake.on("GET", "/sell/finances/v1/transaction", (200, {"transactions": [SALE, LABEL, AD], "total": 3}))
        fake.on("GET", "/sell/finances/v1/payout", (200, {"payouts": [
            {"payoutId": "P-1", "amount": {"value": "202.15", "currency": "USD"}, "payoutStatus": "SUCCEEDED",
             "payoutDate": "2026-11-01T10:00:00.000Z", "transactionCount": 3},
            {"payoutId": "P-2", "amount": {"value": "10.00"}, "payoutDate": "bad-date"},
            {"amount": {"value": "1"}},
        ]}))
        r = client.post(f"{API}/finances/sync", headers=auth_headers)
        assert r.status_code == 200, r.text
        assert r.json() == {"orders_with_fees": 1, "transactions_updated": 1, "payouts": 2}
        assert all(c.url.host == "apiz.sandbox.ebay.com" for c in fake.calls if "finances" in c.url.path)
        db.refresh(txn)
        assert txn.fee_amount == Decimal("47.85") and txn.net_amount == Decimal("202.15")
        payouts = client.get(f"{API}/payouts", headers=auth_headers).json()
        p1 = next(p for p in payouts if p["payout_id"] == "P-1")
        assert p1["resqlo_net"] == "202.15" and p1["difference"] == "0.00" and p1["reconciled"]
        p2 = next(p for p in payouts if p["payout_id"] == "P-2")
        assert p2["resqlo_net"] is None and not p2["reconciled"]
        fees = client.get(f"{API}/fees", headers=auth_headers).json()
        assert fees[0]["total_fees"] == "47.85" and fees[0]["net"] == "202.15"
        assert client.get(f"{API}/fees?order_id=O-1", headers=auth_headers).json()[0]["ad_fee"] == "5.00"
        assert client.get(f"{API}/fees?transaction_id={txn.id}", headers=auth_headers).json()[0]["order_id"] == "O-1"
        # re-sync is idempotent, and a later order re-import keeps the fees
        client.post(f"{API}/finances/sync", headers=auth_headers)
        assert db.query(EbayOrderFees).count() == 1
        ebay_service._upsert_transaction(db, test_user.id, {"orderId": "O-1", "pricingSummary": {"total": {"value": "250.00"}}})
        assert txn.net_amount == Decimal("202.15")

    async def test_unmatched_order_fees_flag_payout(self, client, auth_headers, db, test_user, token, fake):
        fake.on("GET", "/sell/finances/v1/transaction", (200, {"transactions": [SALE], "total": 1}))
        fake.on("GET", "/sell/finances/v1/payout", (200, {"payouts": [{"payoutId": "P-1", "amount": {"value": "216.25"}}]}))
        client.post(f"{API}/finances/sync", headers=auth_headers)
        p = client.get(f"{API}/payouts", headers=auth_headers).json()[0]
        assert p["orders_missing"] == 1 and not p["reconciled"]

    def test_finances_needs_connection(self, client, auth_headers, fake):
        r = client.post(f"{API}/finances/sync", headers=auth_headers)
        assert r.status_code == 409

    def test_status_reports_missing_scopes(self, client, auth_headers, db, token):
        token.scopes = "https://api.ebay.com/oauth/api_scope/sell.inventory"
        db.flush()
        d = client.get(f"{API}/status", headers=auth_headers).json()
        assert "sell.finances" in d["missing_scopes"] and "sell.inventory" not in d["missing_scopes"]


class TestTraffic:
    REPORT = {"header": {"metrics": [{"key": k} for k in ebay_insights.TRAFFIC_METRICS]},
              "records": [{"dimensionValues": [{"value": "LIST1"}],
                           "metricValues": [{"value": 48}, {"value": 900}, {"value": 0.053}, {"value": 0}, {"value": 0}]}]}

    async def test_traffic_cached_daily_with_hint(self, client, auth_headers, db, token, item, fake):
        _listed(db, item)
        fake.on("POST", "/identity/v1/oauth2/token", (200, {"access_token": "app", "expires_in": 7200}))
        fake.on("GET", "/sell/analytics/v1/traffic_report", (200, self.REPORT))
        fake.on("GET", "/buy/browse/v1/item/", (200, {"watchCount": 3}))
        d = client.get(f"{API}/listings/{item.id}/traffic", headers=auth_headers).json()
        assert d["summary"] == "48 views · 3 watchers · 0 sales"
        assert d["price_hint"] and "price may be" in d["price_hint"]
        assert d["click_through_rate"] == "0.0530"
        req = [c for c in fake.calls if "traffic_report" in c.url.path][0]
        assert "listing_ids:{LIST1}" in req.url.params["filter"] and req.url.params["dimension"] == "LISTING"
        client.get(f"{API}/listings/{item.id}/traffic", headers=auth_headers)
        assert len([c for c in fake.calls if "traffic_report" in c.url.path]) == 1  # cached today
        client.get(f"{API}/listings/{item.id}/traffic?refresh=true", headers=auth_headers)
        assert len([c for c in fake.calls if "traffic_report" in c.url.path]) == 2
        assert db.query(EbayListingTraffic).count() == 1

    async def test_no_record_and_no_watch_count(self, client, auth_headers, db, token, item, fake):
        _listed(db, item)
        fake.on("POST", "/identity/v1/oauth2/token", (200, {"access_token": "app", "expires_in": 7200}))
        fake.on("GET", "/sell/analytics/v1/traffic_report", (200, {"records": []}))
        fake.on("GET", "/buy/browse/v1/item/", (404, {}))
        d = client.get(f"{API}/listings/{item.id}/traffic", headers=auth_headers).json()
        assert d["summary"] == "0 views · 0 sales" and d["price_hint"] is None and d["watchers"] is None

    def test_payload_helpers(self):
        assert ebay_insights.traffic_payload(None, None)["available"] is False

    def test_not_listed(self, client, auth_headers, item):
        assert client.get(f"{API}/listings/{item.id}/traffic", headers=auth_headers).status_code == 404


class TestNotifications:
    def _post(self, client, payload, header=None):
        body = json.dumps(payload).encode()
        with patch("app.services.ebay_signature.fetch_public_key", _fake_fetch):
            return client.post(f"{API}/notifications", content=body, headers={
                "Content-Type": "application/json",
                "x-ebay-signature": header if header is not None else sign_header(body)})

    def _payload(self, order_id="O-9", nid="N-1", topic="ITEM_SOLD"):
        return {"metadata": {"topic": topic}, "notification": {"notificationId": nid,
                "data": {"username": "seller1", "orderId": order_id}}}

    def _order(self, item, order_id="O-9"):
        return {"orderId": order_id, "creationDate": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
                "pricingSummary": {"total": {"value": "250.00"}},
                "lineItems": [{"lineItemId": "L-9", "sku": str(item.id), "quantity": 1}]}

    def test_order_imported_once(self, client, db, token, item, fake):
        _listed(db, item, qty=2)
        fake.on("GET", "/sell/fulfillment/v1/order/O-9", (200, self._order(item)))
        r = self._post(client, self._payload())
        assert r.json()["status"] == "imported"
        assert self._post(client, self._payload()).json()["status"] == "duplicate"
        # same order via another notification id: still one deduction
        assert self._post(client, self._payload(nid="N-2")).json()["status"] == "imported"
        db.refresh(item)
        assert item.quantity == 2
        assert db.query(InventoryStockLedger).filter_by(idempotency_key="ebay:order:O-9:L-9").count() == 1
        assert db.query(Transaction).filter_by(external_reference_id="O-9").count() == 1

    def test_new_order_sends_one_sale_alert(self, client, db, token, item, fake, monkeypatch):
        from app.services import push

        sent = []

        async def fake_send(db_, user_id, title, body, data=None):
            sent.append((user_id, title, body, data))
            return 1

        monkeypatch.setattr(push, "send_push", fake_send)
        _listed(db, item, qty=2)
        order = self._order(item)
        order["lineItems"][0]["title"] = "Jordan 1 Chicago"
        fake.on("GET", "/sell/fulfillment/v1/order/O-9", (200, order))
        assert self._post(client, self._payload()).json()["status"] == "imported"
        # Same order again (new notification id): already imported, no second alert.
        assert self._post(client, self._payload(nid="N-2")).json()["status"] == "imported"
        assert sent == [(token.user_id, "Sold on eBay", "Jordan 1 Chicago sold for $250.00.",
                         {"type": "ebay_sale", "orderId": "O-9"})]

    def test_bad_signature_412(self, client, token):
        assert self._post(client, self._payload(), header="bm9wZQ==").status_code == 412

    def test_ignored_and_unmatched(self, client, db, token, item, fake):
        assert self._post(client, self._payload(topic="OTHER")).json()["status"] == "ignored"
        p = self._payload()
        p["notification"]["data"]["username"] = "someone-else"
        assert self._post(client, p).json()["status"] == "unmatched"

    def test_fetch_failure_is_deferred_then_retried(self, client, db, token, item, fake):
        _listed(db, item)
        fake.on("GET", "/sell/fulfillment/v1/order/O-9", (500, {}), (200, self._order(item)))
        assert self._post(client, self._payload()).json()["status"] == "deferred"
        evt = db.query(ProviderWebhookEvent).filter_by(event_id="N-1").one()
        assert evt.error and not evt.processed
        assert self._post(client, self._payload()).json()["status"] == "imported"

    def test_extract_order_id(self):
        assert ebay_insights.extract_order_id({"order": {"orderId": "X"}}) == "X"
        assert ebay_insights.extract_order_id({"order_id": "Y"}) == "Y"
        assert ebay_insights.extract_order_id({}) is None

    def test_challenge(self, client, monkeypatch):
        monkeypatch.setattr(ebay_insights.settings, "EBAY_VERIFICATION_TOKEN", "t" * 40)
        r = client.get(f"{API}/notifications?challenge_code=abc")
        assert len(r.json()["challengeResponse"]) == 64
        monkeypatch.setattr(ebay_insights.settings, "EBAY_VERIFICATION_TOKEN", "")
        assert client.get(f"{API}/notifications?challenge_code=abc").status_code == 503

    def test_subscribe(self, client, auth_headers, token, fake, monkeypatch):
        monkeypatch.setattr(ebay_insights.settings, "EBAY_VERIFICATION_TOKEN", "t" * 40)
        monkeypatch.setattr(ebay_insights.settings, "EBAY_ORDER_TOPICS", "ITEM_SOLD,ORDER_X")
        fake.on("POST", "/identity/v1/oauth2/token", (200, {"access_token": "app", "expires_in": 7200}))
        fake.on("GET", "/commerce/notification/v1/destination", (200, {"destinations": []}))
        fake.on("POST", "/commerce/notification/v1/destination", (201, {"destinationId": "D1"}))
        fake.on("GET", "/commerce/notification/v1/subscription", (200, {"subscriptions": []}))
        fake.on("POST", "/commerce/notification/v1/subscription",
                (201, None), (400, {"errors": [{"message": "Unknown topic"}]}))
        d = client.post(f"{API}/notifications/subscribe", headers=auth_headers).json()
        assert d["destination_id"] == "D1" and d["subscribed"] == ["ITEM_SOLD"] and "ORDER_X" in d["failed"]

    def test_subscribe_reuses_destination_and_subscription(self, client, auth_headers, token, fake, monkeypatch):
        monkeypatch.setattr(ebay_insights.settings, "EBAY_VERIFICATION_TOKEN", "t" * 40)
        fake.on("POST", "/identity/v1/oauth2/token", (200, {"access_token": "app", "expires_in": 7200}))
        fake.on("GET", "/commerce/notification/v1/destination", (200, {"destinations": [
            {"destinationId": "D0", "deliveryConfig": {"endpoint": ebay_insights.settings.EBAY_NOTIFICATION_ENDPOINT}}]}))
        fake.on("GET", "/commerce/notification/v1/subscription",
                (200, {"subscriptions": [{"topicId": "ITEM_SOLD", "status": "ENABLED"}]}))
        d = client.post(f"{API}/notifications/subscribe", headers=auth_headers).json()
        assert d == {"destination_id": "D0", "subscribed": ["ITEM_SOLD"], "failed": {}}

    def test_subscribe_not_configured(self, client, auth_headers, token, monkeypatch):
        monkeypatch.setattr(ebay_insights.settings, "EBAY_VERIFICATION_TOKEN", "")
        assert client.post(f"{API}/notifications/subscribe", headers=auth_headers).status_code == 503


class TestOffers:
    def _eligible(self, fake, ids=("LIST1",)):
        fake.on("GET", "/sell/negotiation/v1/find_eligible_items",
                (200, {"eligibleItems": [{"listingId": i} for i in ids], "total": len(ids)}))

    def test_send_percent_offer(self, client, auth_headers, db, token, item, fake):
        _listed(db, item, qty=2)
        self._eligible(fake)
        fake.on("POST", "/send_offer_to_interested_buyers", (200, {"offers": [{"offerId": "X1"}, {"offerId": "X2"}]}))
        r = client.post(f"{API}/listings/{item.id}/offers", json={"discount_percent": 10, "message": "Deal!"},
                        headers=auth_headers)
        assert r.status_code == 200 and r.json()["offers_sent"] == 2
        body = fake.body("POST", "/send_offer_to_interested_buyers")
        assert body["offeredItems"][0] == {"listingId": "LIST1", "quantity": 1, "discountPercentage": "10"}
        assert body["offerDuration"] == {"unit": "DAY", "value": 2} and body["message"] == "Deal!"
        neg = [c for c in fake.calls if "negotiation" in c.url.path][0]
        assert neg.headers["X-EBAY-C-MARKETPLACE-ID"] == "EBAY_US"

    def test_price_offer_and_validation(self, client, auth_headers, db, token, item, fake):
        _listed(db, item)
        self._eligible(fake)
        fake.on("POST", "/send_offer_to_interested_buyers", (200, {"offers": []}))
        url = f"{API}/listings/{item.id}/offers"
        assert client.post(url, json={"price": "300"}, headers=auth_headers).json()["detail"]["error"] == "offer_not_lower"
        assert client.post(url, json={}, headers=auth_headers).status_code == 422
        assert client.post(url, json={"price": "200", "quantity": 5}, headers=auth_headers).status_code == 422
        r = client.post(url, json={"price": "220", "duration_days": 3}, headers=auth_headers)
        assert r.status_code == 200
        assert fake.body("POST", "/send_offer_to_interested_buyers")["offeredItems"][0]["price"] == {"value": "220.00", "currency": "USD"}

    def test_no_watchers(self, client, auth_headers, db, token, item, fake):
        _listed(db, item)
        self._eligible(fake, ids=("OTHER",))
        e = client.get(f"{API}/listings/{item.id}/offers/eligibility", headers=auth_headers).json()
        assert e["eligible"] is False and e["message"]
        r = client.post(f"{API}/listings/{item.id}/offers", json={"discount_percent": 10}, headers=auth_headers)
        assert r.status_code == 409 and r.json()["detail"]["error"] == "no_interested_buyers"


class TestScopes:
    def test_requested_scopes(self):
        names = [s.rsplit("/", 1)[-1] for s in ebay_service.requested_scopes]
        for s in ("sell.finances", "sell.analytics.readonly", "commerce.notification.subscription", "sell.inventory"):
            assert s in names


def test_fake_is_usable():
    assert FakeEbay().on("GET", "/x", (200, {}))
