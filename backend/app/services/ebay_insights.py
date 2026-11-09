"""eBay insights: real fees and payouts, listing traffic, real-time orders, offers.

- Finances (Sell Finances API, apiz host): getTransactions -> per-order fees
  (final value fee, ad fee, shipping label, other) written to EbayOrderFees and
  onto the imported Transaction (fee_amount / net_amount), so profit matches
  the payout. getPayouts -> EbayPayout with a reconciliation against imported
  orders.
- Traffic (Sell Analytics getTrafficReport + Browse getItem watch count),
  cached once per listing per day.
- Notifications (Notification API): order topics are verified with the same
  x-ebay-signature check as account deletion, then the order is imported via
  the same idempotent path as sync (_upsert_transaction + _apply_order_stock).
  Polling sync remains the fallback.
- Negotiation API: findEligibleItems + sendOfferToInterestedBuyers.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.services.push import notify_ebay_sales
from app.config import settings
from app.models.ebay_insights import EbayListingTraffic, EbayOrderFees, EbayPayout
from app.models.integration import EbayToken
from app.models.inventory import InventoryItem
from app.models.transaction import Transaction
from app.services.ebay import ebay_service
from app.services.ebay_listing import (
    CURRENCY,
    MARKETPLACE_ID,
    EbayApiError,
    SellerSession,
    _active_link,
    _load_item,
    ebay_http,
)

logger = logging.getLogger(__name__)

ZERO = Decimal("0.00")
_PAGE = 200
# A listing with this many views and no sales gets the "price may be high" hint.
HIGH_VIEWS_NO_SALES = 40
TRAFFIC_METRICS = [
    "LISTING_VIEWS_TOTAL",
    "LISTING_IMPRESSION_TOTAL",
    "CLICK_THROUGH_RATE",
    "SALES_CONVERSION_RATE",
    "TRANSACTION",
]


def _money(value: Any) -> Decimal:
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except Exception:
        return ZERO


def _amount(obj: Optional[dict]) -> Decimal:
    return _money((obj or {}).get("value", "0"))


def _finances_base() -> str:
    return ebay_service.identity_base  # apiz.(sandbox.)ebay.com


# ─── Finances: fees per order ──────────────────────────────────────────────────

def classify_fee(fee_type: str) -> str:
    t = (fee_type or "").upper()
    if "AD_FEE" in t or "PROMOTED" in t:
        return "ad_fee"
    if "FINAL_VALUE" in t:
        return "final_value_fee"
    if "SHIPPING_LABEL" in t:
        return "shipping_label"
    return "other_fees"


async def _transactions(seller: SellerSession, since: datetime) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    flt = f"transactionDate:[{since.strftime('%Y-%m-%dT%H:%M:%S.000Z')}..]"
    while True:
        data = await seller.call(
            "GET", "/sell/finances/v1/transaction", base=_finances_base(),
            params={"filter": flt, "limit": _PAGE, "offset": offset},
        )
        batch = (data or {}).get("transactions") or []
        rows.extend(batch)
        offset += len(batch)
        if not batch or offset >= int((data or {}).get("total", offset)):
            return rows


def aggregate_fees(transactions: list[dict]) -> dict[str, dict]:
    """Group Finances transactions by order id into a fee breakdown."""
    orders: dict[str, dict] = {}

    def bucket(order_id: str) -> dict:
        return orders.setdefault(order_id, {
            "final_value_fee": ZERO, "ad_fee": ZERO, "shipping_label": ZERO, "other_fees": ZERO,
            "sale_net": None, "payout_id": None, "lines": [],
        })

    for t in transactions:
        ttype = (t.get("transactionType") or "").upper()
        order_id = str(t.get("orderId") or "")
        if not order_id:
            refs = t.get("references") or []
            order_id = next((str(r.get("referenceId")) for r in refs if (r.get("referenceType") or "").upper() == "ORDER_ID"), "")
        if not order_id:
            continue
        b = bucket(order_id)
        if t.get("payoutId"):
            b["payout_id"] = str(t["payoutId"])
        if ttype == "SALE":
            b["sale_net"] = (b["sale_net"] or ZERO) + _amount(t.get("amount"))
            for line in t.get("orderLineItems") or []:
                line_fees: dict[str, str] = {}
                for fee in line.get("marketplaceFees") or []:
                    kind = classify_fee(fee.get("feeType", ""))
                    amt = _amount(fee.get("amount"))
                    b[kind] += amt
                    line_fees[fee.get("feeType") or kind] = str(amt)
                b["lines"].append({"line_item_id": line.get("lineItemId"), "fees": line_fees})
        elif ttype == "SHIPPING_LABEL":
            b["shipping_label"] += _amount(t.get("amount"))
        elif ttype == "NON_SALE_CHARGE":
            kind = classify_fee(t.get("feeType") or "")
            b[kind if kind != "shipping_label" else "shipping_label"] += _amount(t.get("amount"))
        elif ttype in ("REFUND", "CREDIT", "DISPUTE"):
            continue
    for b in orders.values():
        b["total_fees"] = b["final_value_fee"] + b["ad_fee"] + b["shipping_label"] + b["other_fees"]
    return orders


def apply_fees(db: Session, user_id: uuid.UUID, orders: dict[str, dict]) -> int:
    """Upsert fee rows and set fee/net on the imported Transaction. Idempotent."""
    updated = 0
    for order_id, b in orders.items():
        row = db.query(EbayOrderFees).filter_by(user_id=user_id, order_id=order_id).one_or_none()
        if row is None:
            row = EbayOrderFees(user_id=user_id, order_id=order_id)
            db.add(row)
        for k in ("final_value_fee", "ad_fee", "shipping_label", "other_fees", "total_fees"):
            setattr(row, k, b[k])
        row.sale_net = b["sale_net"]
        row.payout_id = b["payout_id"]
        row.lines = b["lines"]
        txn = (
            db.query(Transaction)
            .filter(Transaction.user_id == user_id, Transaction.source == "ebay",
                    Transaction.external_reference_id == order_id)
            .one_or_none()
        )
        if txn is not None:
            row.transaction_id = txn.id
            fees = min(b["total_fees"], txn.gross_amount or ZERO)
            txn.fee_amount = fees
            txn.net_amount = (txn.gross_amount or ZERO) - fees
            updated += 1
    db.flush()
    return updated


async def _payouts(seller: SellerSession, since: datetime) -> list[dict]:
    data = await seller.call(
        "GET", "/sell/finances/v1/payout", base=_finances_base(),
        params={"filter": f"payoutDate:[{since.strftime('%Y-%m-%dT%H:%M:%S.000Z')}..]", "limit": _PAGE},
    )
    return (data or {}).get("payouts") or []


def reconcile_payouts(db: Session, user_id: uuid.UUID, payouts: list[dict]) -> list[EbayPayout]:
    out = []
    for p in payouts:
        pid = str(p.get("payoutId") or "")
        if not pid:
            continue
        row = db.query(EbayPayout).filter_by(user_id=user_id, payout_id=pid).one_or_none()
        if row is None:
            row = EbayPayout(user_id=user_id, payout_id=pid, amount=ZERO)
            db.add(row)
        row.amount = _amount(p.get("amount"))
        row.currency = (p.get("amount") or {}).get("currency") or CURRENCY
        row.status = p.get("payoutStatus")
        row.transaction_count = p.get("transactionCount")
        if p.get("payoutDate"):
            try:
                row.payout_date = datetime.fromisoformat(str(p["payoutDate"]).replace("Z", "+00:00"))
            except ValueError:
                pass
        fees = db.query(EbayOrderFees).filter_by(user_id=user_id, payout_id=pid).all()
        row.ebay_net = sum(((f.sale_net or ZERO) - f.shipping_label - f.ad_fee for f in fees), ZERO) if fees else None
        matched = [f for f in fees if f.transaction_id]
        row.orders_matched = len(matched)
        row.orders_missing = len(fees) - len(matched)
        if matched:
            nets = db.query(Transaction.net_amount).filter(Transaction.id.in_([f.transaction_id for f in matched])).all()
            row.resqlo_net = sum((n[0] or ZERO for n in nets), ZERO)
        else:
            row.resqlo_net = None
        out.append(row)
    db.flush()
    return out


async def sync_finances(db: Session, user_id: uuid.UUID, days: int = 90) -> dict:
    seller = await SellerSession.open(db, user_id)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    orders = aggregate_fees(await _transactions(seller, since))
    updated = apply_fees(db, user_id, orders)
    payouts = reconcile_payouts(db, user_id, await _payouts(seller, since))
    db.commit()
    return {"orders_with_fees": len(orders), "transactions_updated": updated, "payouts": len(payouts)}


def payout_payload(p: EbayPayout) -> dict:
    diff = (p.amount - p.resqlo_net) if p.resqlo_net is not None else None
    return {
        "payout_id": p.payout_id,
        "amount": str(p.amount),
        "currency": p.currency,
        "status": p.status,
        "payout_date": p.payout_date.isoformat() if p.payout_date else None,
        "transaction_count": p.transaction_count,
        "ebay_net": str(p.ebay_net) if p.ebay_net is not None else None,
        "resqlo_net": str(p.resqlo_net) if p.resqlo_net is not None else None,
        "difference": str(diff) if diff is not None else None,
        "orders_matched": p.orders_matched,
        "orders_missing": p.orders_missing,
        "reconciled": diff is not None and abs(diff) < Decimal("0.01") and p.orders_missing == 0,
    }


def fee_payload(f: EbayOrderFees, gross: Optional[Decimal]) -> dict:
    return {
        "order_id": f.order_id,
        "transaction_id": str(f.transaction_id) if f.transaction_id else None,
        "gross": str(gross) if gross is not None else None,
        "final_value_fee": str(f.final_value_fee),
        "ad_fee": str(f.ad_fee),
        "shipping_label": str(f.shipping_label),
        "other_fees": str(f.other_fees),
        "total_fees": str(f.total_fees),
        "net": str(gross - f.total_fees) if gross is not None else None,
        "payout_id": f.payout_id,
        "lines": f.lines or [],
    }


# ─── Traffic ───────────────────────────────────────────────────────────────────

def _metric(values: list, metrics: list[str], name: str) -> Optional[Decimal]:
    if name not in metrics:
        return None
    i = metrics.index(name)
    if i >= len(values):
        return None
    v = (values[i] or {}).get("value")
    try:
        return Decimal(str(v)) if v is not None else None
    except Exception:
        return None


async def _watch_count(listing_id: str) -> Optional[int]:
    """Browse getItem watchCount (only returned for some keysets/listings)."""
    try:
        bearer = await ebay_http.app_token()
        resp = await ebay_http.send(
            "GET", f"{ebay_service.api_base}/buy/browse/v1/item/v1|{listing_id}|0", bearer,
            headers={"X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID},
        )
        if resp.status_code != 200:
            return None
        wc = (resp.json() or {}).get("watchCount")
        return int(wc) if wc is not None else None
    except (HTTPException, ValueError, TypeError):
        return None


def traffic_payload(row: Optional[EbayListingTraffic], listing_id: Optional[str]) -> dict:
    if row is None:
        return {"listing_id": listing_id, "available": False, "views": None, "impressions": None,
                "click_through_rate": None, "conversion_rate": None, "sales": None, "watchers": None,
                "day": None, "price_hint": None, "summary": None}
    views, sales = row.views or 0, row.sales or 0
    hint = None
    if views >= HIGH_VIEWS_NO_SALES and sales == 0:
        hint = "Lots of views but no sales yet. The price may be a little high."
    parts = [f"{views} view{'s' if views != 1 else ''}"]
    if row.watchers is not None:
        parts.append(f"{row.watchers} watcher{'s' if row.watchers != 1 else ''}")
    parts.append(f"{sales} sale{'s' if sales != 1 else ''}")
    return {
        "listing_id": row.listing_id,
        "available": True,
        "views": row.views,
        "impressions": row.impressions,
        "click_through_rate": str(row.click_through_rate) if row.click_through_rate is not None else None,
        "conversion_rate": str(row.conversion_rate) if row.conversion_rate is not None else None,
        "sales": row.sales,
        "watchers": row.watchers,
        "day": row.day.isoformat(),
        "price_hint": hint,
        "summary": " · ".join(parts),
    }


async def listing_traffic(db: Session, user, item_id: uuid.UUID, *, refresh: bool = False) -> dict:
    """Last-30-day traffic for the item's active listing, cached per day."""
    item = _load_item(db, user.id, item_id)
    link = _active_link(db, user.id, item.id)
    if not link.listing_id:
        return traffic_payload(None, None)
    today = datetime.now(timezone.utc).date()
    row = db.query(EbayListingTraffic).filter_by(user_id=user.id, listing_id=link.listing_id, day=today).one_or_none()
    if row is not None and not refresh:
        return traffic_payload(row, link.listing_id)
    seller = await SellerSession.open(db, user.id)
    start = (today - timedelta(days=29)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")
    data = await seller.call(
        "GET", "/sell/analytics/v1/traffic_report",
        params={
            "dimension": "LISTING",
            "metric": ",".join(TRAFFIC_METRICS),
            "filter": f"marketplace_ids:{{{MARKETPLACE_ID}}},date_range:[{start}..{end}],listing_ids:{{{link.listing_id}}}",
        },
    )
    metrics = [m.get("key") for m in ((data or {}).get("header") or {}).get("metrics") or []] or TRAFFIC_METRICS
    record = next(
        (r for r in (data or {}).get("records") or []
         if any(str(d.get("value")) == link.listing_id for d in r.get("dimensionValues") or [])),
        None,
    )
    values = (record or {}).get("metricValues") or []
    if row is None:
        row = EbayListingTraffic(user_id=user.id, inventory_item_id=item.id, listing_id=link.listing_id, day=today)
        db.add(row)

    def as_int(name: str) -> Optional[int]:
        v = _metric(values, metrics, name)
        return int(v) if v is not None else (0 if record is None else None)

    row.views = as_int("LISTING_VIEWS_TOTAL")
    row.impressions = as_int("LISTING_IMPRESSION_TOTAL")
    row.sales = as_int("TRANSACTION")
    row.click_through_rate = _metric(values, metrics, "CLICK_THROUGH_RATE")
    row.conversion_rate = _metric(values, metrics, "SALES_CONVERSION_RATE")
    row.watchers = await _watch_count(link.listing_id)
    db.commit()
    return traffic_payload(row, link.listing_id)


# ─── Notifications: real-time order import ─────────────────────────────────────

def order_topics() -> set[str]:
    return {t.strip().upper() for t in settings.EBAY_ORDER_TOPICS.split(",") if t.strip()}


def extract_order_id(data: dict) -> Optional[str]:
    for key in ("orderId", "order_id"):
        if data.get(key):
            return str(data[key])
    for nested in ("order", "transaction", "orderLineItem"):
        sub = data.get(nested) or {}
        if isinstance(sub, dict) and sub.get("orderId"):
            return str(sub["orderId"])
    return None


def resolve_seller(db: Session, data: dict) -> Optional[EbayToken]:
    ids = {str(data[k]) for k in ("username", "sellerUsername", "seller", "userId", "sellerId") if data.get(k)}
    if not ids:
        return None
    return db.query(EbayToken).filter(EbayToken.account_id.in_(ids)).first()


async def import_order_now(db: Session, user_id: uuid.UUID, order_id: str) -> bool:
    """Fetch one order and import it through the same idempotent path as sync."""
    seller = await SellerSession.open(db, user_id)
    order = await seller.call("GET", f"/sell/fulfillment/v1/order/{order_id}")
    if not order:
        return False
    _, created = ebay_service._upsert_transaction(db, user_id, order)
    db.flush()
    ebay_service._apply_order_stock(db, user_id, order)
    db.commit()
    if created:
        await notify_ebay_sales(db, user_id, [order])
    return True


# ─── Notification subscription ────────────────────────────────────────────────

async def ensure_destination(endpoint: str, verification_token: str) -> str:
    bearer = await ebay_http.app_token()
    base = f"{ebay_service.api_base}/commerce/notification/v1"
    resp = await ebay_http.send("GET", f"{base}/destination", bearer)
    if resp.status_code == 200:
        for d in (resp.json() or {}).get("destinations") or []:
            if ((d.get("deliveryConfig") or {}).get("endpoint")) == endpoint and d.get("destinationId"):
                return str(d["destinationId"])
    resp = await ebay_http.send(
        "POST", f"{base}/destination", bearer,
        json={"name": "Resqlo orders", "status": "ENABLED",
              "deliveryConfig": {"endpoint": endpoint, "verificationToken": verification_token}},
    )
    if resp.status_code not in (200, 201):
        raise EbayApiError(resp.status_code, "eBay rejected the notification destination.")
    loc = resp.headers.get("location", "")
    dest = loc.rstrip("/").split("/")[-1] if loc else (resp.json() or {}).get("destinationId") if resp.content else None
    if not dest:
        raise EbayApiError(502, "eBay did not return a destination id.")
    return str(dest)


async def subscribe_orders(db: Session, user_id: uuid.UUID) -> dict:
    if not settings.EBAY_VERIFICATION_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "ebay_notifications_not_configured", "message": "EBAY_VERIFICATION_TOKEN is not set."},
        )
    seller = await SellerSession.open(db, user_id)
    destination_id = await ensure_destination(settings.EBAY_NOTIFICATION_ENDPOINT, settings.EBAY_VERIFICATION_TOKEN)
    existing = await seller.call("GET", "/commerce/notification/v1/subscription", params={"limit": 100})
    have = {s.get("topicId") for s in (existing or {}).get("subscriptions") or [] if s.get("status") == "ENABLED"}
    subscribed, failed = [], {}
    for topic in sorted(order_topics()):
        if topic in have:
            subscribed.append(topic)
            continue
        try:
            await seller.call(
                "POST", "/commerce/notification/v1/subscription",
                json={"topicId": topic, "status": "ENABLED", "destinationId": destination_id,
                      "payload": {"format": "JSON", "schemaVersion": "1.0", "deliveryProtocol": "HTTPS"}},
            )
            subscribed.append(topic)
        except EbayApiError as exc:
            failed[topic] = exc.detail.get("message") if isinstance(exc.detail, dict) else str(exc.detail)
    return {"destination_id": destination_id, "subscribed": subscribed, "failed": failed}


# ─── Negotiation: offers to watchers ──────────────────────────────────────────

_NEG_HEADERS = {"X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID}


async def offer_eligibility(db: Session, user, item_id: uuid.UUID) -> dict:
    item = _load_item(db, user.id, item_id)
    link = _active_link(db, user.id, item.id)
    seller = await SellerSession.open(db, user.id)
    offset, eligible = 0, False
    while not eligible:
        data = await seller.call(
            "GET", "/sell/negotiation/v1/find_eligible_items",
            params={"limit": _PAGE, "offset": offset}, headers=_NEG_HEADERS,
        )
        batch = (data or {}).get("eligibleItems") or []
        eligible = any(str(e.get("listingId")) == link.listing_id for e in batch)
        offset += len(batch)
        if not batch or offset >= int((data or {}).get("total", offset)):
            break
    return {"listing_id": link.listing_id, "eligible": eligible,
            "message": None if eligible else "No interested buyers yet. eBay allows offers once someone watches the item."}


async def send_offer(
    db: Session, user, item_id: uuid.UUID, *, price: Optional[Decimal], discount_percent: Optional[int],
    duration_days: int, message: Optional[str], quantity: int = 1,
) -> dict:
    if (price is None) == (discount_percent is None):
        raise HTTPException(status_code=422, detail={"error": "offer_amount", "message": "Send either a price or a percent off."})
    item = _load_item(db, user.id, item_id)
    link = _active_link(db, user.id, item.id)
    if price is not None and link.listed_price is not None and _money(price) >= link.listed_price:
        raise HTTPException(status_code=422, detail={"error": "offer_not_lower", "message": "The offer must be below the listing price."})
    if quantity > (link.listed_quantity or 1):
        raise HTTPException(status_code=422, detail={"error": "offer_quantity", "message": "Quantity is above what is listed."})
    eligibility = await offer_eligibility(db, user, item_id)
    if not eligibility["eligible"]:
        raise HTTPException(status_code=409, detail={"error": "no_interested_buyers", "message": eligibility["message"]})
    offered: dict[str, Any] = {"listingId": link.listing_id, "quantity": quantity}
    if price is not None:
        offered["price"] = {"value": str(_money(price)), "currency": CURRENCY}
    else:
        offered["discountPercentage"] = str(discount_percent)
    body: dict[str, Any] = {
        "allowCounterOffer": False,
        "offerDuration": {"unit": "DAY", "value": duration_days},
        "offeredItems": [offered],
    }
    if message:
        body["message"] = message
    seller = await SellerSession.open(db, user.id)
    data = await seller.call(
        "POST", "/sell/negotiation/v1/send_offer_to_interested_buyers", json=body, headers=_NEG_HEADERS
    )
    offers = (data or {}).get("offers") or []
    return {"listing_id": link.listing_id, "offers_sent": len(offers),
            "offer_ids": [o.get("offerId") for o in offers if o.get("offerId")]}


def today() -> date:
    return datetime.now(timezone.utc).date()


def item_fee_rows(db: Session, user_id: uuid.UUID, limit: int = 50) -> list[dict]:
    rows = (
        db.query(EbayOrderFees, Transaction.gross_amount)
        .outerjoin(Transaction, Transaction.id == EbayOrderFees.transaction_id)
        .filter(EbayOrderFees.user_id == user_id)
        .order_by(EbayOrderFees.updated_at.desc())
        .limit(limit)
        .all()
    )
    return [fee_payload(f, g) for f, g in rows]


__all__ = ["sync_finances", "listing_traffic", "subscribe_orders", "import_order_now", "send_offer",
           "offer_eligibility", "aggregate_fees", "apply_fees", "reconcile_payouts", "InventoryItem"]
