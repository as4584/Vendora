"""One-tap eBay business-policy setup.

New sellers have no fulfillment / payment / return policies and often are not
opted in to business policies at all, so listing fails. ``setup_policies``
opts them in (Account API ``program/opt_in``) and creates any missing
"Resqlo default ..." policies on EBAY_US. Existing policies are reused, so the
call is idempotent; ``ebay_listing.fetch_policies`` then picks them up.
"""
from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Callable, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.services.ebay_listing import (
    CURRENCY,
    MARKETPLACE_ID,
    EbayApiError,
    SellerSession,
    _error_message,
    _has_scope,
    _money,
)

POLICY_PROGRAM = "SELLING_POLICY_MANAGEMENT"
POLICY_NAME_PREFIX = "Resqlo default"
DEFAULT_FLAT_SHIPPING = Decimal("12.00")
DEFAULT_HANDLING_DAYS = 2
DEFAULT_RETURN_DAYS = 30
_CATEGORY_TYPES = [{"name": "ALL_EXCLUDING_MOTORS_VEHICLES"}]

# kind -> (account api path, list field, id field, human label)
POLICY_KINDS: dict[str, tuple[str, str, str, str]] = {
    "fulfillment": ("fulfillment_policy", "fulfillmentPolicies", "fulfillmentPolicyId", "shipping"),
    "payment": ("payment_policy", "paymentPolicies", "paymentPolicyId", "payment"),
    "return": ("return_policy", "returnPolicies", "returnPolicyId", "return"),
}

# eBay error ids / phrases meaning "this account is not (yet) in business policies".
_NOT_OPTED_IN_IDS = (20403,)
_NOT_OPTED_IN_HINTS = ("opted in", "opt in", "opt-in", "not eligible", "business polic")

PENDING_MESSAGE = (
    "eBay is still turning on business policies for your account. This usually takes a minute - "
    "try again shortly."
)


def _errors_text(exc: EbayApiError) -> str:
    return " ".join(
        str(e.get("longMessage") or e.get("message") or "") for e in exc.ebay_errors if isinstance(e, dict)
    ).lower()


def _not_opted_in(exc: EbayApiError) -> bool:
    if exc.has_error_id(*_NOT_OPTED_IN_IDS):
        return True
    text = _errors_text(exc)
    return any(h in text for h in _NOT_OPTED_IN_HINTS)


async def _open(db: Session, user_id: uuid.UUID) -> SellerSession:
    seller = await SellerSession.open(db, user_id)
    scopes = seller.token.scopes
    if scopes and not _has_scope(scopes, "sell.account"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "ebay_reconnect_required",
                "message": "Reconnect eBay to let Resqlo manage your selling policies.",
            },
        )
    return seller


async def _list_policies(seller: SellerSession, kind: str) -> Optional[list[dict]]:
    """Existing policies of one kind, or None if the seller is not opted in."""
    path, field, _, _ = POLICY_KINDS[kind]
    try:
        data = await seller.call("GET", f"/sell/account/v1/{path}", params={"marketplace_id": MARKETPLACE_ID})
    except EbayApiError as exc:
        if exc.ebay_status in (400, 403, 404) and not exc.retryable:
            return None
        raise
    return [p for p in ((data or {}).get(field) or []) if isinstance(p, dict)]


def _summary(kind: str, policy: dict) -> dict:
    _, _, id_field, label = POLICY_KINDS[kind]
    return {"id": str(policy.get(id_field) or ""), "name": policy.get("name") or label, "label": label}


async def policy_overview(db: Session, user_id: uuid.UUID) -> dict:
    """What business policies the seller has on EBAY_US and which kinds are missing."""
    seller = await _open(db, user_id)
    policies: dict[str, Optional[dict]] = {}
    opted_in = True
    for kind in POLICY_KINDS:
        found = await _list_policies(seller, kind)
        if found is None:
            opted_in = False
        policies[kind] = _summary(kind, found[0]) if found else None
    missing = [POLICY_KINDS[k][3] for k, v in policies.items() if not v or not v["id"]]
    return {
        "opted_in": opted_in,
        "marketplace_id": MARKETPLACE_ID,
        "policies": policies,
        "missing": missing,
        "ready": not missing,
    }


async def opt_in_business_policies(seller: SellerSession) -> str:
    """Opt the seller into business policies. Returns 'already' or 'opted_in'."""
    try:
        data = await seller.call("GET", "/sell/account/v1/program/get_opted_in_programs")
        programs = (data or {}).get("programs") or []
        if any(isinstance(p, dict) and p.get("programType") == POLICY_PROGRAM for p in programs):
            return "already"
    except EbayApiError as exc:
        if exc.retryable:
            raise
        # Could not read programs; just try to opt in.
    try:
        await seller.call("POST", "/sell/account/v1/program/opt_in", json={"programType": POLICY_PROGRAM})
    except EbayApiError as exc:
        if exc.ebay_status == 409 or "already" in _errors_text(exc):
            return "already"
        raise
    return "opted_in"


def fulfillment_payload(*, free_shipping: bool = False, flat_cost: Optional[Decimal] = None) -> dict:
    cost = Decimal("0.00") if free_shipping else _money(flat_cost if flat_cost is not None else DEFAULT_FLAT_SHIPPING)
    label = "free shipping" if free_shipping else f"${cost} shipping"
    return {
        "name": f"{POLICY_NAME_PREFIX} shipping",
        "description": f"USPS Priority, {DEFAULT_HANDLING_DAYS}-day handling, {label}",
        "marketplaceId": MARKETPLACE_ID,
        "categoryTypes": _CATEGORY_TYPES,
        "handlingTime": {"value": DEFAULT_HANDLING_DAYS, "unit": "DAY"},
        "shippingOptions": [
            {
                "optionType": "DOMESTIC",
                "costType": "FLAT_RATE",
                "shippingServices": [
                    {
                        "sortOrder": 1,
                        "shippingCarrierCode": "USPS",
                        "shippingServiceCode": "USPSPriority",
                        "freeShipping": free_shipping,
                        "shippingCost": {"value": str(cost), "currency": CURRENCY},
                    }
                ],
            }
        ],
    }


def payment_payload() -> dict:
    # eBay managed payments: no paymentMethods list needed.
    return {
        "name": f"{POLICY_NAME_PREFIX} payment",
        "description": "Immediate payment through eBay",
        "marketplaceId": MARKETPLACE_ID,
        "categoryTypes": _CATEGORY_TYPES,
        "immediatePay": True,
    }


def return_payload(*, returns_accepted: bool = True) -> dict:
    body: dict = {
        "name": f"{POLICY_NAME_PREFIX} returns",
        "marketplaceId": MARKETPLACE_ID,
        "categoryTypes": _CATEGORY_TYPES,
        "returnsAccepted": returns_accepted,
    }
    if returns_accepted:
        body.update(
            description=f"{DEFAULT_RETURN_DAYS}-day returns, buyer pays return shipping",
            returnPeriod={"value": DEFAULT_RETURN_DAYS, "unit": "DAY"},
            returnShippingCostPayer="BUYER",
            refundMethod="MONEY_BACK",
        )
    else:
        body["description"] = "No returns"
    return body


async def setup_policies(
    db: Session,
    user_id: uuid.UUID,
    *,
    free_shipping: bool = False,
    flat_shipping_cost: Optional[Decimal] = None,
    returns_accepted: bool = True,
) -> dict:
    """Opt in and create any missing default policies. Existing policies are reused."""
    seller = await _open(db, user_id)
    try:
        opt_in = await opt_in_business_policies(seller)
    except EbayApiError as exc:
        raise EbayApiError(
            exc.ebay_status,
            "eBay would not turn on business policies for this account: "
            + _error_message(exc.ebay_errors, "unknown error"),
            exc.ebay_errors,
            code="ebay_opt_in_failed",
        ) from exc

    builders: dict[str, Callable[[], dict]] = {
        "fulfillment": lambda: fulfillment_payload(free_shipping=free_shipping, flat_cost=flat_shipping_cost),
        "payment": payment_payload,
        "return": lambda: return_payload(returns_accepted=returns_accepted),
    }
    result: dict[str, dict] = {}
    failed: dict[str, str] = {}
    pending = False
    for kind, (path, _, _, label) in POLICY_KINDS.items():
        try:
            existing = await _list_policies(seller, kind)
        except EbayApiError as exc:
            failed[label] = _error_message(exc.ebay_errors, f"Could not read {label} policies.")
            continue
        if existing:
            result[kind] = {**_summary(kind, existing[0]), "created": False}
            continue
        body = builders[kind]()
        try:
            created = await seller.call("POST", f"/sell/account/v1/{path}", json=body)
        except EbayApiError as exc:
            if _not_opted_in(exc):
                pending = True
                failed[label] = PENDING_MESSAGE
            else:
                failed[label] = _error_message(exc.ebay_errors, f"eBay rejected the {label} policy.")
            continue
        summary = _summary(kind, {**body, **(created or {})})
        if not summary["id"]:
            failed[label] = f"eBay did not return an id for the {label} policy."
            continue
        result[kind] = {**summary, "created": True}

    if failed:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "ebay_policies_pending" if pending else "ebay_policy_setup_incomplete",
                "message": PENDING_MESSAGE if pending else (
                    "Some selling policies could not be set up: "
                    + "; ".join(f"{k}: {v}" for k, v in failed.items())
                ),
                "failed": failed,
                "policies": result,
                "opt_in": opt_in,
                "retry_after_seconds": 60 if pending else None,
            },
        )
    return {"opt_in": opt_in, "marketplace_id": MARKETPLACE_ID, "policies": result, "ready": True}
