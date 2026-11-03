"""eBay write-back: list an inventory item, revise price/quantity, end listing.

Flow (Sell Inventory API):
  createOrReplaceInventoryItem (PUT inventory_item/{sku})
    -> createOffer (POST offer)  [reuses an existing offer for the SKU]
    -> publishOffer (POST offer/{offerId}/publish)  => listingId

Prerequisites resolved here:
  - merchantLocationKey: an existing inventory location is reused; otherwise one
    is created once (createInventoryLocation) from the seller's business address
    ZIP (or a postal_code supplied by the request) and cached on EbayToken.
  - business policies: fulfillment / payment / return policy ids come from the
    Account API. A seller with none gets an actionable 409.
  - categoryId: request value, else Taxonomy getCategorySuggestions, else the
    sneaker default 15709 when the item looks like footwear.

Listing state lives on InventoryExternalLink (provider "ebay"): offer_id,
listing_id, listing_status (draft|active|ended|sold|error), listed_price,
listed_quantity (the seller's cap; eBay quantity = min(cap, available stock)).

All HTTP goes through ``EbayHttp`` so tests can inject an ``httpx.MockTransport``.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from statistics import median
from typing import Any, Optional

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.config import settings
from app.models.integration import EbayToken
from app.models.inventory import InventoryExternalLink, InventoryItem
from app.security.token_encryption import decrypt_token
from app.services.ebay import LISTING_SCOPES, ebay_service
from app.services.inventory import get_available_quantity

logger = logging.getLogger(__name__)

MARKETPLACE_ID = "EBAY_US"
CURRENCY = "USD"
SNEAKER_CATEGORY_ID = "15709"  # Clothing, Shoes & Accessories > Men > Men's Shoes > Athletic Shoes
_APP_SCOPE = "https://api.ebay.com/oauth/api_scope"
_FOOTWEAR_HINT = re.compile(
    r"\b(sneaker|sneakers|shoe|shoes|jordan|yeezy|dunk|air max|air force|nike|adidas|new balance|asics)\b",
    re.I,
)

# eBay Inventory API ConditionEnum values accepted from clients as-is.
EBAY_CONDITIONS = {
    "NEW", "LIKE_NEW", "NEW_OTHER", "NEW_WITH_DEFECTS", "CERTIFIED_REFURBISHED",
    "USED_EXCELLENT", "USED_VERY_GOOD", "USED_GOOD", "USED_ACCEPTABLE", "FOR_PARTS_OR_NOT_WORKING",
    "PRE_OWNED_EXCELLENT", "PRE_OWNED_FAIR",
}
_CONDITION_ALIASES = {
    "new": "NEW", "ds": "NEW", "deadstock": "NEW", "brand new": "NEW", "new with box": "NEW",
    "new_with_box": "NEW", "nwt": "NEW",
    "new other": "NEW_OTHER", "new_other": "NEW_OTHER", "new no box": "NEW_OTHER",
    "new_no_box": "NEW_OTHER", "vnds": "NEW_OTHER", "open box": "NEW_OTHER",
    "like new": "LIKE_NEW", "like_new": "LIKE_NEW",
    "new with defects": "NEW_WITH_DEFECTS",
    "used": "USED_EXCELLENT", "pre-owned": "USED_EXCELLENT", "preowned": "USED_EXCELLENT",
    "used excellent": "USED_EXCELLENT", "excellent": "USED_EXCELLENT",
    "used very good": "USED_VERY_GOOD", "very good": "USED_VERY_GOOD",
    "used good": "USED_GOOD", "good": "USED_GOOD",
    "used acceptable": "USED_ACCEPTABLE", "acceptable": "USED_ACCEPTABLE", "fair": "USED_ACCEPTABLE",
    "for parts": "FOR_PARTS_OR_NOT_WORKING",
}

LISTING_ACTIVE = "active"


def map_condition(raw: Optional[str]) -> str:
    """Map a Resqlo/free-text condition to an eBay ConditionEnum (default NEW)."""
    if not raw:
        return "NEW"
    value = raw.strip()
    if value.upper() in EBAY_CONDITIONS:
        return value.upper()
    mapped = _CONDITION_ALIASES.get(value.lower().replace("-", " ").replace("_", " ")) or _CONDITION_ALIASES.get(
        value.lower()
    )
    if mapped:
        return mapped
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={
            "error": "invalid_condition",
            "message": f"Unknown condition '{raw}'. Use new, new_other, used, or an eBay condition value.",
        },
    )


def _money(value: Any) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


class EbayApiError(HTTPException):
    """eBay returned an error. ``ebay_errors`` keeps eBay's error list for callers."""

    def __init__(self, http_status: int, message: str, ebay_errors: Optional[list] = None, code: str = "ebay_error"):
        self.ebay_status = http_status
        self.ebay_errors = ebay_errors or []
        # 4xx from eBay is a problem with the request/account -> 502 would hide that.
        mapped = status.HTTP_502_BAD_GATEWAY if http_status >= 500 or http_status == 0 else status.HTTP_409_CONFLICT
        super().__init__(status_code=mapped, detail={"error": code, "message": message, "ebay_status": http_status})

    @property
    def retryable(self) -> bool:
        return self.ebay_status == 0 or self.ebay_status == 429 or self.ebay_status >= 500

    def has_error_id(self, *ids: int) -> bool:
        return any(int(e.get("errorId", 0) or 0) in ids for e in self.ebay_errors if isinstance(e, dict))


def _error_message(errors: list, fallback: str) -> str:
    for e in errors:
        if isinstance(e, dict):
            msg = e.get("longMessage") or e.get("message")
            if msg:
                return str(msg)
    return fallback


class EbayHttp:
    """Thin eBay REST client: bearer auth, one 429 retry, one 401 refresh-and-retry."""

    rate_limit_sleep: float = 2.0

    def __init__(self) -> None:
        self._app_token: Optional[str] = None
        self._app_token_exp: float = 0.0

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=30, transport=ebay_service.transport)

    async def send(
        self,
        method: str,
        url: str,
        bearer: str,
        *,
        json: Any = None,
        params: Optional[dict] = None,
        headers: Optional[dict] = None,
    ) -> httpx.Response:
        hdrs = {"Authorization": f"Bearer {bearer}", "Accept": "application/json"}
        if json is not None:
            hdrs["Content-Type"] = "application/json"
            hdrs["Content-Language"] = "en-US"
        hdrs.update(headers or {})
        try:
            async with self.client() as client:
                resp = await client.request(method, url, json=json, params=params, headers=hdrs)
                if resp.status_code == 429:
                    await asyncio.sleep(self.rate_limit_sleep)
                    resp = await client.request(method, url, json=json, params=params, headers=hdrs)
        except httpx.HTTPError as exc:
            raise EbayApiError(0, f"Could not reach eBay: {exc.__class__.__name__}", code="ebay_unreachable") from exc
        return resp

    async def app_token(self) -> str:
        """Application (client-credentials) token for Browse / Taxonomy. Cached in memory."""
        if self._app_token and time.time() < self._app_token_exp - 60:
            return self._app_token
        if not (ebay_service.client_id and ebay_service.client_secret):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"error": "ebay_not_configured", "message": "eBay app keys are not configured."},
            )
        try:
            async with self.client() as client:
                resp = await client.post(
                    ebay_service.token_url,
                    headers={
                        "Authorization": ebay_service._basic_auth_header(),
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    data={"grant_type": "client_credentials", "scope": _APP_SCOPE},
                )
        except httpx.HTTPError as exc:
            raise EbayApiError(0, "Could not reach eBay.", code="ebay_unreachable") from exc
        if resp.status_code >= 400:
            raise EbayApiError(resp.status_code, "eBay application token request failed.", code="ebay_app_token_failed")
        payload = resp.json()
        self._app_token = payload["access_token"]
        self._app_token_exp = time.time() + int(payload.get("expires_in", 7200))
        return self._app_token

    def reset_app_token(self) -> None:
        self._app_token = None
        self._app_token_exp = 0.0


ebay_http = EbayHttp()


# ─── Seller-token calls ─────────────────────────────────────────────────────────

class SellerSession:
    """A seller's eBay token for one operation; refreshes on expiry or a 401."""

    def __init__(self, db: Session, token: EbayToken):
        self.db = db
        self.token = token

    @classmethod
    async def open(cls, db: Session, user_id: uuid.UUID) -> "SellerSession":
        token = ebay_service.get_token(db, user_id)
        if not token:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"error": "ebay_not_connected", "message": "Connect your eBay account first (Settings > Sync center)."},
            )
        if token.scopes and not _has_scope(token.scopes, "sell.inventory"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "error": "ebay_reconnect_required",
                    "message": "Reconnect eBay to grant listing permissions (your connection is read-only).",
                },
            )
        token = await ebay_service._ensure_valid_token(db, token)
        return cls(db, token)

    async def call(self, method: str, path: str, *, json: Any = None, params: Optional[dict] = None,
                   ok: tuple[int, ...] = (200, 201, 204)) -> Optional[dict]:
        url = f"{ebay_service.api_base}{path}"
        resp = await ebay_http.send(method, url, decrypt_token(self.token.access_token), json=json, params=params)
        if resp.status_code == 401:
            self.token = await ebay_service._refresh_access_token(self.db, self.token)
            resp = await ebay_http.send(method, url, decrypt_token(self.token.access_token), json=json, params=params)
        if resp.status_code not in ok:
            errors: list = []
            try:
                errors = (resp.json() or {}).get("errors") or []
            except ValueError:
                pass
            if resp.status_code == 403 and not errors:
                errors = [{"message": "eBay denied access — reconnect eBay to grant listing permissions."}]
            logger.warning("eBay %s %s -> %s", method, path, resp.status_code)
            raise EbayApiError(resp.status_code, _error_message(errors, f"eBay request failed ({resp.status_code})."), errors)
        if resp.status_code == 204 or not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            return None


def _has_scope(scopes: str, name: str) -> bool:
    return any(s.rstrip("/").endswith("/" + name) for s in scopes.split())


# ─── Helpers ────────────────────────────────────────────────────────────────────

def image_signature(item_id: uuid.UUID | str, side: str) -> str:
    msg = f"ebay-image:{item_id}:{side}".encode()
    return hmac.new(settings.SECRET_KEY.encode(), msg, hashlib.sha256).hexdigest()[:32]


def public_image_urls(item: InventoryItem) -> list[str]:
    """eBay needs public HTTPS image URLs. Photos stored as data URLs are served
    through a signed public endpoint; plain http(s) URLs are passed through."""
    urls: list[str] = []
    base = settings.PUBLIC_API_BASE_URL.rstrip("/")
    for side, value in (("front", item.photo_front_url), ("back", item.photo_back_url)):
        if not value:
            continue
        if value.startswith(("http://", "https://")):
            urls.append(value)
        elif value.startswith("data:image/"):
            urls.append(f"{base}/integrations/ebay/images/{item.id}/{side}/{image_signature(item.id, side)}.jpg")
    return urls


def decode_data_url(value: str) -> tuple[bytes, str]:
    header, _, data = value.partition(",")
    media = header[5:].split(";")[0] or "image/jpeg"
    return base64.b64decode(data), media


def _attrs(item: InventoryItem) -> dict:
    return item.custom_attributes if isinstance(item.custom_attributes, dict) else {}


def looks_like_footwear(item: InventoryItem) -> bool:
    text = " ".join(filter(None, [item.category, item.name, str(_attrs(item).get("brand") or "")]))
    return bool(_FOOTWEAR_HINT.search(text))


def default_title(item: InventoryItem) -> str:
    brand = str(_attrs(item).get("brand") or "").strip()
    parts = []
    if brand and brand.lower() not in item.name.lower():
        parts.append(brand)
    parts.append(item.name.strip())
    style = str(_attrs(item).get("style_code") or _attrs(item).get("sku") or "").strip()
    if style and style.lower() not in item.name.lower():
        parts.append(style)
    if item.size:
        parts.append(f"Size {item.size}")
    return " ".join(parts)[:80]


def build_aspects(item: InventoryItem, category_id: str) -> dict[str, list[str]]:
    attrs = _attrs(item)
    aspects: dict[str, list[str]] = {}
    brand = str(attrs.get("brand") or "").strip()
    aspects["Brand"] = [brand or "Unbranded"]
    sneaker = category_id == SNEAKER_CATEGORY_ID or looks_like_footwear(item)
    if item.size:
        aspects["US Shoe Size" if sneaker else "Size"] = [str(item.size)]
    if item.color:
        aspects["Color"] = [item.color]
    style = str(attrs.get("style_code") or "").strip()
    if style:
        aspects["Style Code"] = [style]
    if sneaker:
        aspects.setdefault("Type", ["Athletic"])
        if category_id == SNEAKER_CATEGORY_ID:
            aspects.setdefault("Department", ["Men"])
    return aspects


def _zip_from(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    m = re.search(r"\b(\d{5})(?:-\d{4})?\b", text)
    return m.group(1) if m else None


def get_ebay_link(db: Session, user_id: uuid.UUID, item_id: uuid.UUID) -> Optional[InventoryExternalLink]:
    return (
        db.query(InventoryExternalLink)
        .filter(
            InventoryExternalLink.user_id == user_id,
            InventoryExternalLink.provider == "ebay",
            InventoryExternalLink.inventory_item_id == item_id,
        )
        .order_by(InventoryExternalLink.offer_id.is_(None))
        .first()
    )


def listing_url(listing_id: Optional[str]) -> Optional[str]:
    if not listing_id:
        return None
    host = "sandbox.ebay.com" if ebay_service._sandbox else "www.ebay.com"
    return f"https://{host}/itm/{listing_id}"


def link_payload(link: Optional[InventoryExternalLink]) -> dict:
    if not link or not link.offer_id:
        return {"listed": False, "status": None, "offer_id": None, "listing_id": None, "url": None,
                "price": None, "quantity": None, "sku": link.external_id if link else None}
    return {
        "listed": link.listing_status == LISTING_ACTIVE,
        "status": link.listing_status,
        "offer_id": link.offer_id,
        "listing_id": link.listing_id,
        "url": listing_url(link.listing_id) if link.listing_status == LISTING_ACTIVE else None,
        "price": str(link.listed_price) if link.listed_price is not None else None,
        "quantity": link.listed_quantity,
        "sku": link.external_id,
    }


# ─── Prerequisites ──────────────────────────────────────────────────────────────

async def fetch_policies(seller: SellerSession) -> dict[str, str]:
    kinds = {
        "fulfillmentPolicyId": ("fulfillment_policy", "fulfillmentPolicies", "shipping"),
        "paymentPolicyId": ("payment_policy", "paymentPolicies", "payment"),
        "returnPolicyId": ("return_policy", "returnPolicies", "return"),
    }
    found: dict[str, str] = {}
    missing: list[str] = []
    for key, (path, field, label) in kinds.items():
        try:
            data = await seller.call("GET", f"/sell/account/v1/{path}", params={"marketplace_id": MARKETPLACE_ID})
        except EbayApiError as exc:
            # 20403: seller is not opted in to business policies.
            if exc.ebay_status in (400, 403, 404) and not exc.retryable:
                missing.append(label)
                continue
            raise
        policies = (data or {}).get(field) or []
        if policies:
            found[key] = str(policies[0].get(f"{path.split('_')[0]}PolicyId") or policies[0].get(key) or "")
            if not found[key]:
                missing.append(label)
        else:
            missing.append(label)
    if missing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "ebay_policies_missing",
                "missing": missing,
                "message": (
                    "Your eBay account has no " + ", ".join(missing) + " policy. In eBay Seller Hub go to "
                    "Account > Business policies, opt in, and create shipping, payment and return policies, "
                    "then try again."
                ),
                "help_url": "https://www.ebay.com/bp/manage",
            },
        )
    return found


async def ensure_location(seller: SellerSession, user_postal: Optional[str]) -> str:
    token = seller.token
    if token.merchant_location_key:
        return token.merchant_location_key
    data = await seller.call("GET", "/sell/inventory/v1/location", params={"limit": 20})
    for loc in (data or {}).get("locations") or []:
        if loc.get("merchantLocationKey"):
            token.merchant_location_key = str(loc["merchantLocationKey"])[:36]
            seller.db.commit()
            return token.merchant_location_key
    if not user_postal:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "ebay_location_required",
                "message": "eBay needs a ship-from location. Add a business address with a ZIP code in Settings "
                           "(or send postal_code), then try again.",
            },
        )
    key = "resqlo-default"
    await seller.call(
        "POST",
        f"/sell/inventory/v1/location/{key}",
        json={
            "location": {"address": {"postalCode": user_postal, "country": "US"}},
            "locationTypes": ["WAREHOUSE"],
            "name": "Resqlo ship-from",
            "merchantLocationStatus": "ENABLED",
        },
        ok=(200, 201, 204),
    )
    token.merchant_location_key = key
    seller.db.commit()
    return key


async def suggest_category(item: InventoryItem, title: str) -> Optional[str]:
    """Taxonomy getCategorySuggestions (application token). None on any failure."""
    try:
        bearer = await ebay_http.app_token()
        base = ebay_service.api_base
        resp = await ebay_http.send(
            "GET", f"{base}/commerce/taxonomy/v1/get_default_category_tree_id", bearer,
            params={"marketplace_id": MARKETPLACE_ID},
        )
        tree_id = (resp.json() or {}).get("categoryTreeId", "0") if resp.status_code == 200 else "0"
        resp = await ebay_http.send(
            "GET", f"{base}/commerce/taxonomy/v1/category_tree/{tree_id}/get_category_suggestions", bearer,
            params={"q": title[:100]},
        )
        if resp.status_code != 200:
            return None
        for s in (resp.json() or {}).get("categorySuggestions") or []:
            cid = (s.get("category") or {}).get("categoryId")
            if cid:
                return str(cid)
    except (HTTPException, ValueError, KeyError):
        return None
    return None


# ─── Operations ─────────────────────────────────────────────────────────────────

def _load_item(db: Session, user_id: uuid.UUID, item_id: uuid.UUID) -> InventoryItem:
    item = (
        db.query(InventoryItem)
        .filter(InventoryItem.id == item_id, InventoryItem.user_id == user_id, InventoryItem.deleted_at.is_(None))
        .one_or_none()
    )
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    return item


async def create_listing(
    db: Session,
    user,
    item_id: uuid.UUID,
    *,
    price: Decimal,
    quantity: Optional[int] = None,
    title: Optional[str] = None,
    condition: Optional[str] = None,
    category_id: Optional[str] = None,
    description: Optional[str] = None,
    postal_code: Optional[str] = None,
) -> dict:
    item = _load_item(db, user.id, item_id)
    available = get_available_quantity(item)
    if available <= 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "out_of_stock", "message": "This item has no stock to list."},
        )
    qty = min(quantity or available, available)
    if qty < 1:
        raise HTTPException(status_code=422, detail={"error": "invalid_quantity", "message": "Quantity must be at least 1."})
    price = _money(price)
    if price <= 0:
        raise HTTPException(status_code=422, detail={"error": "invalid_price", "message": "Price must be above $0."})

    link = get_ebay_link(db, user.id, item.id)
    if link and link.offer_id and link.listing_status == LISTING_ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "already_listed", "message": "This item is already listed on eBay.", "listing": link_payload(link)},
        )

    images = public_image_urls(item)
    if not images:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "photo_required", "message": "Add at least one photo before listing on eBay."},
        )
    ebay_condition = map_condition(condition or item.condition)
    listing_title = (title or default_title(item)).strip()[:80]

    seller = await SellerSession.open(db, user.id)
    policies = await fetch_policies(seller)
    location_key = await ensure_location(seller, postal_code or _zip_from(getattr(user, "business_address", None)))

    cat = category_id or await suggest_category(item, listing_title)
    if not cat:
        if looks_like_footwear(item):
            cat = SNEAKER_CATEGORY_ID
        else:
            raise HTTPException(
                status_code=422,
                detail={"error": "category_required", "message": "eBay could not suggest a category. Pick one and try again."},
            )

    sku = link.external_id if link else str(item.id)
    desc = (description or item.notes or listing_title).strip()
    await seller.call(
        "PUT",
        f"/sell/inventory/v1/inventory_item/{sku}",
        json={
            "availability": {"shipToLocationAvailability": {"quantity": qty}},
            "condition": ebay_condition,
            "product": {
                "title": listing_title,
                "description": desc,
                "aspects": build_aspects(item, cat),
                "imageUrls": images,
                **({"upc": [item.upc]} if item.upc else {}),
            },
        },
    )

    offer_body = {
        "sku": sku,
        "marketplaceId": MARKETPLACE_ID,
        "format": "FIXED_PRICE",
        "availableQuantity": qty,
        "categoryId": cat,
        "listingDescription": desc,
        "listingPolicies": policies,
        "pricingSummary": {"price": {"value": str(price), "currency": CURRENCY}},
        "merchantLocationKey": location_key,
    }
    offer_id = link.offer_id if link and link.offer_id else None
    if offer_id:
        await seller.call("PUT", f"/sell/inventory/v1/offer/{offer_id}", json=offer_body)
    else:
        try:
            created = await seller.call("POST", "/sell/inventory/v1/offer", json=offer_body)
            offer_id = str((created or {}).get("offerId") or "")
        except EbayApiError as exc:
            # 25002: an offer already exists for this SKU — reuse it.
            if not exc.has_error_id(25002):
                raise
            existing = await seller.call("GET", "/sell/inventory/v1/offer", params={"sku": sku, "marketplace_id": MARKETPLACE_ID})
            offers = (existing or {}).get("offers") or []
            if not offers:
                raise
            offer_id = str(offers[0]["offerId"])
            await seller.call("PUT", f"/sell/inventory/v1/offer/{offer_id}", json=offer_body)
        if not offer_id:
            raise EbayApiError(502, "eBay did not return an offer id.")

    now = datetime.now(timezone.utc)
    if not link:
        link = InventoryExternalLink(
            inventory_item_id=item.id, user_id=user.id, provider="ebay", external_id=sku, external_sku=sku,
        )
        db.add(link)
    link.offer_id = offer_id
    link.listed_price = price
    link.listed_quantity = qty
    link.listing_status = "draft"
    link.last_synced_at = now
    db.commit()  # keep the offer id even if publish fails, so a retry reuses it

    try:
        published = await seller.call("POST", f"/sell/inventory/v1/offer/{offer_id}/publish")
    except EbayApiError:
        link.listing_status = "error"
        db.commit()
        raise
    link.listing_id = str((published or {}).get("listingId") or "") or None
    link.listing_status = LISTING_ACTIVE
    if item.status == "in_stock":
        item.status = "listed"
    db.commit()
    db.refresh(link)
    return link_payload(link)


async def push_price_quantity(
    seller: SellerSession, link: InventoryExternalLink, *, price: Optional[Decimal], quantity: Optional[int]
) -> None:
    offer: dict[str, Any] = {"offerId": link.offer_id}
    req: dict[str, Any] = {"sku": link.external_id, "offers": [offer]}
    if quantity is not None:
        offer["availableQuantity"] = quantity
        req["shipToLocationAvailability"] = {"quantity": quantity}
    if price is not None:
        offer["price"] = {"value": str(price), "currency": CURRENCY}
    data = await seller.call("POST", "/sell/inventory/v1/bulk_update_price_quantity", json={"requests": [req]})
    for r in (data or {}).get("responses") or []:
        code = int(r.get("statusCode") or 200)
        if code >= 400:
            errs = r.get("errors") or []
            raise EbayApiError(code, _error_message(errs, "eBay rejected the price/quantity update."), errs)


async def withdraw(seller: SellerSession, link: InventoryExternalLink) -> None:
    try:
        await seller.call("POST", f"/sell/inventory/v1/offer/{link.offer_id}/withdraw")
    except EbayApiError as exc:
        # 25713: offer is not published (already ended) — the goal state.
        if not exc.has_error_id(25713):
            raise


def _active_link(db: Session, user_id: uuid.UUID, item_id: uuid.UUID) -> InventoryExternalLink:
    link = get_ebay_link(db, user_id, item_id)
    if not link or not link.offer_id or link.listing_status != LISTING_ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "not_listed", "message": "This item is not listed on eBay."},
        )
    return link


async def update_listing(db: Session, user, item_id: uuid.UUID, *, price: Optional[Decimal], quantity: Optional[int]) -> dict:
    item = _load_item(db, user.id, item_id)
    link = _active_link(db, user.id, item.id)
    if price is None and quantity is None:
        raise HTTPException(status_code=422, detail={"error": "nothing_to_update", "message": "Send a price or quantity."})
    new_price = _money(price) if price is not None else None
    if new_price is not None and new_price <= 0:
        raise HTTPException(status_code=422, detail={"error": "invalid_price", "message": "Price must be above $0."})
    cap = quantity if quantity is not None else link.listed_quantity
    push_qty = min(cap or 0, get_available_quantity(item)) if quantity is not None else None
    seller = await SellerSession.open(db, user.id)
    if push_qty is not None and push_qty <= 0:
        await withdraw(seller, link)
        link.listing_status = "ended"
    else:
        await push_price_quantity(seller, link, price=new_price, quantity=push_qty)
        if new_price is not None:
            link.listed_price = new_price
        if quantity is not None:
            link.listed_quantity = quantity
    link.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(link)
    return link_payload(link)


async def end_listing(db: Session, user, item_id: uuid.UUID) -> dict:
    item = _load_item(db, user.id, item_id)
    link = _active_link(db, user.id, item.id)
    seller = await SellerSession.open(db, user.id)
    await withdraw(seller, link)
    link.listing_status = "ended"
    link.last_synced_at = datetime.now(timezone.utc)
    if item.status == "listed":
        item.status = "in_stock"
    db.commit()
    db.refresh(link)
    return link_payload(link)


async def sync_listing_quantity(db: Session, item_id: uuid.UUID) -> str:
    """Outbox handler: make eBay's quantity match Resqlo stock (never above it).

    Returns a short outcome string. Idempotent: pushes an absolute quantity.
    """
    item = db.query(InventoryItem).filter(InventoryItem.id == item_id).one_or_none()
    if item is None:
        return "item_gone"
    link = get_ebay_link(db, item.user_id, item.id)
    if not link or not link.offer_id or link.listing_status != LISTING_ACTIVE:
        return "not_listed"
    available = get_available_quantity(item)
    target = min(link.listed_quantity or available, available)
    seller = await SellerSession.open(db, item.user_id)
    if target <= 0:
        await withdraw(seller, link)
        link.listing_status = "ended"
        outcome = "withdrawn"
    else:
        await push_price_quantity(seller, link, price=None, quantity=target)
        outcome = f"quantity={target}"
    link.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    return outcome


# ─── Comps (Browse API, application token) ──────────────────────────────────────

async def fetch_comps(query: str, *, condition: Optional[str] = None, limit: int = 20) -> dict:
    """Comparable prices for *query*.

    eBay sold-price data (Marketplace Insights API) is restricted and not part of
    a standard keyset, so unless EBAY_MARKETPLACE_INSIGHTS is enabled this uses
    Browse API *active* listings and labels them honestly as asking prices.
    """
    query = query.strip()[:100]
    bearer = await ebay_http.app_token()
    headers = {"X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID}
    filters = ["buyingOptions:{FIXED_PRICE}", f"priceCurrency:{CURRENCY}"]
    if condition in ("new", "used"):
        filters.append("conditions:{NEW}" if condition == "new" else "conditions:{USED}")
    params = {"q": query, "limit": str(limit), "filter": ",".join(filters)}

    kind = "active_asks"
    url = f"{ebay_service.api_base}/buy/browse/v1/item_summary/search"
    field = "itemSummaries"
    if settings.EBAY_MARKETPLACE_INSIGHTS:
        kind = "sold"
        url = f"{ebay_service.api_base}/buy/marketplace_insights/v1_beta/item_sales/search"
        field = "itemSales"
    resp = await ebay_http.send("GET", url, bearer, params=params, headers=headers)
    if resp.status_code in (401, 403) and kind == "sold":
        # Insights not granted to this keyset: fall back to honest active asks.
        kind, field = "active_asks", "itemSummaries"
        resp = await ebay_http.send(
            "GET", f"{ebay_service.api_base}/buy/browse/v1/item_summary/search", bearer, params=params, headers=headers
        )
    if resp.status_code == 401:
        ebay_http.reset_app_token()
    if resp.status_code >= 400:
        raise EbayApiError(resp.status_code, "eBay price lookup failed.", code="ebay_comps_failed")

    rows = []
    for s in (resp.json() or {}).get(field) or []:
        price = (s.get("lastSoldPrice") or s.get("price") or {}) if kind == "sold" else (s.get("price") or {})
        if price.get("value") is None or (price.get("currency") or CURRENCY) != CURRENCY:
            continue
        rows.append({
            "title": s.get("title"),
            "price": str(_money(price["value"])),
            "condition": s.get("condition"),
            "url": s.get("itemWebUrl"),
            "image_url": (s.get("image") or {}).get("imageUrl"),
            "sold_date": s.get("lastSoldDate") if kind == "sold" else None,
        })
    prices = sorted(Decimal(r["price"]) for r in rows)
    summary = None
    if prices:
        summary = {
            "low": str(prices[0]),
            "median": str(_money(median(prices))),
            "high": str(prices[-1]),
        }
    return {
        "query": query,
        "kind": kind,
        "label": "eBay sold prices" if kind == "sold" else "eBay active asks (not sold prices)",
        "count": len(rows),
        "summary": summary,
        "items": rows,
    }


__all__ = [
    "LISTING_SCOPES", "EbayApiError", "SellerSession", "create_listing", "update_listing", "end_listing",
    "sync_listing_quantity", "fetch_comps", "link_payload", "get_ebay_link", "map_condition",
]
