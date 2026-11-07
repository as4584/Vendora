"""Realistic demo account -> JSON fixtures for the app's visual layout checks.

Always runs as a contract test: every read endpoint the app's screens call
must answer 200 for a busy seller. With UI_FIXTURES_OUT=<path> set, the
responses are also written out for mobile/e2e/visual (Playwright stubs), so
the screenshots show real server-shaped data instead of hand-written mocks.
"""
import json
import os
from decimal import Decimal

from app.models.inventory import InventoryItem

STOCK = [
    ("Nike Dunk Low Retro White Black", "Sneakers", "DD1391-100", "195866137738", "10", "White/Black", "110.00", "165.00", 3),
    ("Air Jordan 4 Retro Bred Reimagined", "Sneakers", "FV5029-006", "197862948123", "9.5", "Black/Cement Grey", "215.00", "290.00", 1),
    ("adidas Samba OG Cloud White", "Sneakers", "B75806", "4060512043157", "8.5", "White/Black/Gum", "90.00", "130.00", 2),
    ("New Balance 9060 Sea Salt", "Sneakers", "U9060AAA", "196432651234", "11", "Sea Salt", "140.00", "185.00", 1),
    ("Pokemon 151 Booster Bundle (Sealed)", "Collectibles", "PKM-151-BB", "820650853517", None, None, "28.00", "45.00", 6),
    ("Supreme Box Logo Hoodie FW23 Heather Grey With An Extra Long Name", "Clothing", "SUP-BOGO-FW23", None, "L", "Heather Grey", "250.00", "420.00", 1),
]

SCREENS = {
    "me": "/auth/me",
    "dashboard": "/dashboard",
    "inventory": "/inventory?limit=50&offset=0",
    "transactions": "/transactions?limit=50&offset=0",
    "invoices": "/invoices?limit=50&offset=0",
    "features": "/features",
    "tiers": "/features/tiers",
    "subscription": "/subscriptions/me",
    "integrations_health": "/integrations/health",
    "advanced": "/dashboard/advanced?days=30",
    "show_summary": "/dashboard/show-summary",
}


def test_busy_seller_screens_all_load(client, auth_headers, db, test_user):
    test_user.subscription_tier = "pro"
    test_user.sales_tax_rate = Decimal("6.625")
    db.commit()
    items = []
    for name, cat, sku, upc, size, color, buy, sell, qty in STOCK:
        item = InventoryItem(
            user_id=test_user.id, name=name, category=cat, sku=sku, upc=upc, size=size, color=color,
            buy_price=Decimal(buy), expected_sell_price=Decimal(sell), quantity=qty, condition="New",
        )
        db.add(item)
        items.append(item)
    # The Dunks come in several sizes, so checkout shows the size picker.
    items[0].custom_attributes = {"variants": [
        {"size": "9", "quantity": 1}, {"size": "10", "quantity": 2}, {"size": "10.5", "quantity": 0},
    ]}
    db.commit()

    # $244 subtotal - $14 discount = $230, + 6.625% tax = $245.24; paid cash + card.
    sale = client.post("/api/v1/transactions/order", json={
        "fee_amount": "3.10", "discount_amount": "14.00", "tax_rate": "6.625",
        "payments": [{"method": "cash", "amount": "200.00"}, {"method": "card", "amount": "45.24"}],
        "lines": [{"item_id": str(items[0].id), "quantity": 1, "unit_price": "160.00", "size": "10"},
                  {"item_id": str(items[4].id), "quantity": 2, "unit_price": "42.00"}],
    }, headers=auth_headers)
    assert sale.status_code == 201, sale.text
    card = client.post("/api/v1/transactions/order", json={
        "method": "zelle", "fee_amount": "0",
        "lines": [{"item_id": str(items[1].id), "quantity": 1, "unit_price": "285.00"}],
    }, headers=auth_headers)
    assert card.status_code == 201, card.text
    refund = client.post(f"/api/v1/transactions/{card.json()['transactions'][0]['id']}/refund",
                         json={"reason": "Wrong size"}, headers=auth_headers)
    assert refund.status_code == 201, refund.text
    inv = client.post("/api/v1/invoices", json={
        "customer_name": "Marcus Reed", "customer_email": "marcus@example.com", "customer_phone": "(201) 555-0148",
        "items": [{"inventory_item_id": str(items[2].id), "description": items[2].name, "quantity": 1, "unit_price": "130.00"}],
    }, headers=auth_headers)
    assert inv.status_code in (200, 201), inv.text
    # A deposit taken at the show, so the invoice screens show a balance due.
    paid = client.post(f"/api/v1/invoices/{inv.json()['id']}/payments", json={
        "amount": "50.00", "method": "cash", "note": "Deposit at the show",
    }, headers=auth_headers)
    assert paid.status_code == 201, paid.text
    # Marcus also bought at the booth, so his customer page shows both kinds of history.
    booth = client.post("/api/v1/transactions/order", json={
        "method": "card", "customer_id": inv.json()["customer_id"],
        "lines": [{"item_id": str(items[3].id), "quantity": 1, "unit_price": "185.00"}],
    }, headers=auth_headers)
    assert booth.status_code == 201, booth.text
    wholesale = client.post("/api/v1/customers", json={
        "name": "Garden State Cards Wholesale With A Long Business Name", "email": "orders@gardenstatecards.example",
        "phone": "732-555-0190", "address": "12 Route 9, Freehold NJ", "tax_exempt": True,
    }, headers=auth_headers)
    assert wholesale.status_code == 201, wholesale.text

    out = {"item_id": str(items[0].id), "invoice_id": inv.json()["id"], "customer_id": inv.json()["customer_id"]}
    paths = dict(SCREENS)
    paths["item"] = f"/inventory/{items[0].id}"
    paths["item_activity"] = f"/inventory/{items[0].id}/activity?limit=20"
    paths["invoice"] = f"/invoices/{out['invoice_id']}"
    paths["customers"] = "/customers"
    paths["customer"] = f"/customers/{out['customer_id']}"
    for key, path in paths.items():
        resp = client.get(f"/api/v1{path}", headers=auth_headers)
        assert resp.status_code == 200, (key, resp.status_code, resp.text[:200])
        out[key] = resp.json()

    target = os.environ.get("UI_FIXTURES_OUT")
    if target:
        with open(target, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=2, default=str)
