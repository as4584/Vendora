"""Security regression: no route that takes an object id may read or change
another user's object.

Every route in the OpenAPI schema with a path parameter is exercised: user A
owns one object of each kind, user B calls the route with A's id and must get
404 (the object does not exist *for B*). New id routes are picked up
automatically; a route whose id kind is unknown fails the test so it gets an
explicit fixture rather than silently passing.
"""
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.main import app
from app.models.inventory import InventoryImportJob, InventoryItem
from app.models.invoice import Invoice
from app.models.provider import ProviderSyncRun, ReconciliationIssue
from app.models.provider_outbox import ProviderOutbox
from app.models.scan_memory import ScanMemory
from app.models.stockx import StockxListing
from app.models.transaction import Transaction

PARAM = re.compile(r"\{(\w+)\}")

# Path params that are intentionally public / not owned objects.
PUBLIC_ROUTES = {
    # Public seller storefront: by design readable by anyone.
    "/api/v1/sellers/{user_id}",
}


def _routes():
    for path, operations in app.openapi()["paths"].items():
        if not PARAM.search(path) or path in PUBLIC_ROUTES:
            continue
        for method in operations:
            yield method.upper(), path


def _param_kind(path: str, name: str) -> str:
    if name == "item_id":
        return "item"
    if name == "job_id":
        return "outbox" if "/outbox/" in path else "import_job"
    return {
        "order_id": "order",
        "txn_id": "txn",
        "invoice_id": "invoice",
        "run_id": "run",
        "issue_id": "issue",
        "listing_id": "stockx_listing",
        "barcode": "barcode",
    }[name]


@pytest.fixture()
def victim_objects(db, test_user):
    uid = test_user.id
    item = InventoryItem(user_id=uid, name="Victim sneaker", quantity=3, status="in_stock",
                         buy_price=Decimal("40.00"), expected_sell_price=Decimal("100.00"))
    db.add(item)
    db.flush()
    order_id = uuid.uuid4()
    txn = Transaction(user_id=uid, item_id=item.id, method="cash", gross_amount=Decimal("100.00"),
                      net_amount=Decimal("100.00"), order_id=order_id)
    invoice = Invoice(user_id=uid, number=1, customer_name="Victim customer")
    job = InventoryImportJob(user_id=uid, status="previewed")
    run = ProviderSyncRun(user_id=uid, provider="square", status="failed")
    db.add_all([txn, invoice, job, run])
    db.flush()
    issue = ReconciliationIssue(user_id=uid, provider="square", issue_type="stock_drift", sync_run_id=run.id)
    outbox = ProviderOutbox(user_id=uid, provider="ebay", action="update_quantity", payload={},
                            idempotency_key=f"k-{uuid.uuid4()}", status="failed",
                            inventory_item_id=item.id)
    listing = StockxListing(user_id=uid, inventory_item_id=item.id, product_id="p", variant_id="v",
                            amount=Decimal("120.00"), status="active", listing_id="L-1")
    memory = ScanMemory(user_id=uid, barcode="0012345678905", fields={"name": "Victim product"})
    db.add_all([issue, outbox, listing, memory])
    db.flush()
    return {
        "item": item.id, "order": order_id, "txn": txn.id, "invoice": invoice.id,
        "import_job": job.id, "run": run.id, "issue": issue.id, "outbox": outbox.id,
        "stockx_listing": listing.id, "barcode": "0012345678905",
    }


BODIES = {
    "PUT": {"name": "pwned", "customer_name": "pwned",
            "items": [{"description": "x", "quantity": 1, "unit_price": "1.00"}]},
    "PATCH": {"status": "sold", "price": "1.00", "quantity": 0, "amount": "1.00",
              "photo_front": None, "resolution_note": "x"},
    "POST": {"amount": "1.00", "method": "cash", "price": "1.00", "quantity": 1,
             "product_id": "p", "variant_id": "v"},
}


@pytest.mark.parametrize("method,path", sorted(set(_routes())))
def test_other_user_cannot_touch_object(client, db, victim_objects, second_auth_headers, method, path):
    url = PARAM.sub(lambda m: str(victim_objects[_param_kind(path, m.group(1))]), path)
    body = dict(BODIES.get(method) or {})
    if "reconciliation-issues" in path:
        body["status"] = "resolved"
    response = client.request(method, url, headers=second_auth_headers, json=body or None)
    assert response.status_code == 404, (method, path, response.status_code, response.text[:300])


def test_victim_objects_unchanged_after_attacks(client, db, victim_objects, second_auth_headers):
    """Belt and braces: after every mutating attempt, A's data is intact."""
    for method, path in sorted(set(_routes())):
        if method == "GET":
            continue
        url = PARAM.sub(lambda m: str(victim_objects[_param_kind(path, m.group(1))]), path)
        client.request(method, url, headers=second_auth_headers, json=BODIES.get(method))
    db.expire_all()
    item = db.get(InventoryItem, victim_objects["item"])
    assert item is not None and item.deleted_at is None
    assert item.name == "Victim sneaker" and item.quantity == 3
    assert db.query(ScanMemory).filter_by(barcode="0012345678905").count() == 1
    inv = db.get(Invoice, victim_objects["invoice"])
    assert inv.customer_name == "Victim customer"
    assert db.get(ReconciliationIssue, victim_objects["issue"]).status == "open"


def test_owner_can_read_own_item(client, victim_objects, auth_headers):
    """Sanity: the fixture objects are real and reachable by their owner."""
    assert client.get(f"/api/v1/inventory/{victim_objects['item']}", headers=auth_headers).status_code == 200
    assert client.get(f"/api/v1/transactions/{victim_objects['txn']}", headers=auth_headers).status_code == 200
    assert client.get(f"/api/v1/invoices/{victim_objects['invoice']}", headers=auth_headers).status_code == 200
    _ = datetime.now(timezone.utc)
