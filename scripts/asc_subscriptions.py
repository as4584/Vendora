"""Create Vendora's App Store auto-renewable subscriptions (idempotent).

Group "Vendora Plans":
  com.vendora.partner.monthly  Pro + Partner  $24.99/mo  (level 1, highest)
  com.vendora.pro.monthly      Pro            $19.99/mo  (level 2)
  com.vendora.pro.yearly       Pro            $199.99/yr (level 2)

Usage: python scripts/asc_subscriptions.py [inspect|apply]
"""
from __future__ import annotations

import json
import sys

import asc_testflight_setup as asc

APP_ID = asc.APP_ID
GROUP_NAME = "Vendora Plans"
PRODUCTS = [
    {"productId": "com.vendora.partner.monthly", "name": "Pro + Partner Monthly", "period": "ONE_MONTH", "level": 1,
     "price": "24.99", "display": "Pro + Partner",
     "description": "Pro plus storefront, badge, priority support"},
    {"productId": "com.vendora.pro.monthly", "name": "Pro Monthly", "period": "ONE_MONTH", "level": 2,
     "price": "19.99", "display": "Vendora Pro",
     "description": "Unlimited inventory, invoices and exports"},
    {"productId": "com.vendora.pro.yearly", "name": "Pro Yearly", "period": "ONE_YEAR", "level": 2,
     "price": "199.99", "display": "Vendora Pro (Yearly)",
     "description": "Unlimited inventory, invoices and exports"},
]


def req(t, method, path, body=None):
    status, data = asc.asc_request(t, method, path, body)
    if status >= 400:
        raise RuntimeError(f"{method} {path} -> {status}: {json.dumps(asc.error_summary(data))}")
    return data


def all_pages(t, path):
    out, url = [], path
    while url:
        data = req(t, "GET", url)
        out += data.get("data", [])
        nxt = data.get("links", {}).get("next")
        url = nxt.replace(asc.ASC_BASE, "") if nxt else None
    return out


def ensure_group(t):
    groups = req(t, "GET", f"/apps/{APP_ID}/subscriptionGroups").get("data", [])
    for g in groups:
        if g["attributes"]["referenceName"] == GROUP_NAME:
            return g["id"]
    g = req(t, "POST", "/subscriptionGroups", {"data": {"type": "subscriptionGroups",
        "attributes": {"referenceName": GROUP_NAME},
        "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})["data"]
    req(t, "POST", "/subscriptionGroupLocalizations", {"data": {"type": "subscriptionGroupLocalizations",
        "attributes": {"locale": "en-US", "name": "Vendora Plans"},
        "relationships": {"subscriptionGroup": {"data": {"type": "subscriptionGroups", "id": g["id"]}}}}})
    return g["id"]


def ensure_subscription(t, group_id, p):
    subs = req(t, "GET", f"/subscriptionGroups/{group_id}/subscriptions").get("data", [])
    sub = next((s for s in subs if s["attributes"]["productId"] == p["productId"]), None)
    if sub is None:
        sub = req(t, "POST", "/subscriptions", {"data": {"type": "subscriptions",
            "attributes": {"name": p["name"], "productId": p["productId"], "subscriptionPeriod": p["period"],
                           "groupLevel": p["level"], "familySharable": False},
            "relationships": {"group": {"data": {"type": "subscriptionGroups", "id": group_id}}}}})["data"]
    sid = sub["id"]

    locs = req(t, "GET", f"/subscriptions/{sid}/subscriptionLocalizations").get("data", [])
    if not any(l["attributes"]["locale"] == "en-US" for l in locs):
        req(t, "POST", "/subscriptionLocalizations", {"data": {"type": "subscriptionLocalizations",
            "attributes": {"locale": "en-US", "name": p["display"], "description": p["description"]},
            "relationships": {"subscription": {"data": {"type": "subscriptions", "id": sid}}}}})

    status, _ = asc.asc_request(t, "GET", f"/subscriptions/{sid}/subscriptionAvailability")
    if status == 404:
        territories = all_pages(t, "/territories?limit=200")
        req(t, "POST", "/subscriptionAvailabilities", {"data": {"type": "subscriptionAvailabilities",
            "attributes": {"availableInNewTerritories": True},
            "relationships": {
                "subscription": {"data": {"type": "subscriptions", "id": sid}},
                "availableTerritories": {"data": [{"type": "territories", "id": x["id"]} for x in territories]}}}})
    prices = req(t, "GET", f"/subscriptions/{sid}/prices?limit=1").get("data", [])
    if not prices:
        points = all_pages(t, f"/subscriptions/{sid}/pricePoints?filter%5Bterritory%5D=USA&limit=200")
        point = next(pp for pp in points if pp["attributes"]["customerPrice"] == p["price"])
        # Base price in the US, then Apple's equalized price in every other territory.
        targets = [point] + all_pages(t, f"/subscriptionPricePoints/{point['id']}/equalizations?limit=200")
        for pp in targets:
            req(t, "POST", "/subscriptionPrices", {"data": {"type": "subscriptionPrices",
                "attributes": {"preserveCurrentPrice": False},
                "relationships": {
                    "subscription": {"data": {"type": "subscriptions", "id": sid}},
                    "subscriptionPricePoint": {"data": {"type": "subscriptionPricePoints", "id": pp["id"]}}}}})

    return sid


def inspect(t):
    rows = []
    for g in req(t, "GET", f"/apps/{APP_ID}/subscriptionGroups").get("data", []):
        for s in req(t, "GET", f"/subscriptionGroups/{g['id']}/subscriptions").get("data", []):
            a = s["attributes"]
            rows.append({"group": g["attributes"]["referenceName"], "productId": a["productId"],
                         "state": a.get("state"), "id": s["id"]})
    return rows


def main():
    t = asc.make_token()
    if (sys.argv[1:] or ["inspect"])[0] == "apply":
        gid = ensure_group(t)
        for p in PRODUCTS:
            ensure_subscription(t, gid, p)
            t = asc.make_token()
    print(json.dumps(inspect(t), indent=2))


if __name__ == "__main__":
    main()
