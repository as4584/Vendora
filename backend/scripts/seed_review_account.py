"""Create or refresh the App Store Review demo account for Resqlo.

Run manually by the owner (never in CI, never automatically):

    cd backend
    REVIEW_ACCOUNT_EMAIL=appreview@example.com \
    REVIEW_ACCOUNT_PASSWORD='<strong password, 10+ chars>' \
    DATABASE_URL=postgresql://... \
        python -m scripts.seed_review_account [--dry-run] [--free]

Idempotent: each run wipes the demo account's data (by deleting and
recreating the user with the SAME id, so DB cascades clear everything) and
seeds a fresh, realistic dataset through the real API routes:

  * ~15 inventory items, several with per-size stock (sneakers, apparel)
  * 3 customers
  * a show started 3 hours ago, with 3 sales in it (one paid split
    cash + card, one tagged to a customer) -> a populated show summary
  * an invoice for a customer with a partial payment recorded

The reviewer gets Pro + Partner unless --free is passed (use --free if App
Review asks to exercise the in-app purchase themselves).

Secrets are read from the environment only; nothing is hardcoded.
"""
from __future__ import annotations

import argparse
import os
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

MIN_PASSWORD_LENGTH = 10
BUSINESS_NAME = "Shoreline Kicks & Vintage"
API = "/api/v1"


def _sizes(*pairs: tuple[str, int]) -> dict[str, Any]:
    return {"variants": [{"size": size, "quantity": qty} for size, qty in pairs]}


# (name, category, sku, condition, qty, buy, ask, extra)
ITEMS: list[dict[str, Any]] = [
    dict(name="Air Jordan 1 Retro High OG 'Chicago Lost & Found'", category="Sneakers", sku="AJ1-LF",
         condition="New", quantity=4, buy_price="180.00", expected_sell_price="320.00", platform="In person",
         custom_attributes=_sizes(("9", 1), ("10", 2), ("11", 1))),
    dict(name="Nike Dunk Low 'Panda'", category="Sneakers", sku="DUNK-PANDA", condition="New", quantity=5,
         buy_price="100.00", expected_sell_price="150.00", platform="In person",
         custom_attributes=_sizes(("8", 1), ("9", 2), ("10.5", 2))),
    dict(name="New Balance 550 White Green", category="Sneakers", sku="NB550-WG", condition="New", quantity=3,
         buy_price="85.00", expected_sell_price="130.00", platform="In person",
         custom_attributes=_sizes(("9", 1), ("10", 1), ("11", 1))),
    dict(name="Yeezy Boost 350 V2 'Onyx'", category="Sneakers", sku="YZY-ONYX", condition="Used - Excellent",
         quantity=1, size="10", buy_price="150.00", expected_sell_price="230.00", platform="eBay"),
    dict(name="Travis Scott x Jordan 1 Low 'Mocha'", category="Sneakers", sku="TS-AJ1L-MOCHA", condition="New",
         quantity=1, size="9.5", buy_price="900.00", expected_sell_price="1250.00", platform="StockX"),
    dict(name="Supreme Box Logo Hoodie FW22", category="Streetwear", sku="SUP-BOGO-FW22", condition="New",
         quantity=3, buy_price="320.00", expected_sell_price="480.00", platform="In person",
         custom_attributes=_sizes(("M", 1), ("L", 1), ("XL", 1))),
    dict(name="Essentials Fear of God Hoodie 'Oatmeal'", category="Streetwear", sku="FOG-ESS-OAT",
         condition="New", quantity=6, buy_price="55.00", expected_sell_price="95.00", platform="In person",
         custom_attributes=_sizes(("S", 1), ("M", 2), ("L", 2), ("XL", 1))),
    dict(name="Vintage 1994 Chicago Bulls Champions Tee", category="Vintage", sku="VTG-BULLS-94",
         condition="Used - Good", quantity=1, size="XL", buy_price="40.00", expected_sell_price="120.00",
         platform="In person"),
    dict(name="Vintage Harley-Davidson 3D Emblem Tee", category="Vintage", sku="VTG-HD-3D", condition="Used - Good",
         quantity=1, size="L", buy_price="35.00", expected_sell_price="95.00", platform="In person"),
    dict(name="Carhartt WIP Detroit Jacket", category="Outerwear", sku="CAR-DET-BRN", condition="Used - Excellent",
         quantity=2, buy_price="90.00", expected_sell_price="175.00", platform="In person",
         custom_attributes=_sizes(("M", 1), ("L", 1))),
    dict(name="Arc'teryx Beta LT Jacket", category="Outerwear", sku="ARC-BETA-LT", condition="Used - Excellent",
         quantity=1, size="M", buy_price="220.00", expected_sell_price="340.00", platform="eBay"),
    dict(name="Pokemon Charizard VMAX PSA 10", category="Trading Cards", sku="PKM-CHAR-VMAX-10",
         condition="Graded", quantity=1, buy_price="190.00", expected_sell_price="285.00", platform="In person"),
    dict(name="Pokemon 151 Booster Bundle (Sealed)", category="Trading Cards", sku="PKM-151-BB", condition="New",
         quantity=8, buy_price="28.00", expected_sell_price="45.00", platform="In person"),
    dict(name="New Era 59FIFTY Yankees Fitted", category="Accessories", sku="NE-NYY-5950", condition="New",
         quantity=4, buy_price="22.00", expected_sell_price="45.00", platform="In person",
         custom_attributes=_sizes(("7 1/4", 2), ("7 3/8", 2))),
    dict(name="Stussy Basic Logo Tee", category="Streetwear", sku="STU-BASIC-BLK", condition="New", quantity=5,
         buy_price="18.00", expected_sell_price="45.00", platform="In person",
         custom_attributes=_sizes(("S", 1), ("M", 2), ("L", 2))),
]

CUSTOMERS: list[dict[str, Any]] = [
    dict(name="Maya Rodriguez", email="maya.rodriguez@example.com", phone="(732) 555-0142",
         notes="Collects Jordan 1s, size 9."),
    dict(name="Jordan Lee", email="jordan.lee@example.com", phone="(201) 555-0188",
         notes="Card show regular."),
    dict(name="Priya Shah", email="priya.shah@example.com", phone="(973) 555-0110",
         notes="Buys vintage tees for her shop; invoice on net 15."),
]


@dataclass
class SeedReport:
    email: str
    dry_run: bool
    tier: str
    user_id: str | None = None
    actions: list[str] = field(default_factory=list)
    items: int = 0
    customers: int = 0
    sales: int = 0
    invoices: int = 0

    def log(self, message: str) -> None:
        self.actions.append(message)
        print(("[dry-run] " if self.dry_run else "") + message)


def read_credentials(env: dict[str, str] | None = None) -> tuple[str, str]:
    env = dict(os.environ if env is None else env)
    email = (env.get("REVIEW_ACCOUNT_EMAIL") or "").strip().lower()
    password = env.get("REVIEW_ACCOUNT_PASSWORD") or ""
    if not email or "@" not in email:
        raise SystemExit("Set REVIEW_ACCOUNT_EMAIL to the App Review demo login email.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise SystemExit(f"Set REVIEW_ACCOUNT_PASSWORD ({MIN_PASSWORD_LENGTH}+ characters).")
    return email, password


def _check(response, what: str) -> dict:
    if response.status_code >= 300:
        raise RuntimeError(f"{what} failed ({response.status_code}): {response.text[:300]}")
    return response.json() if response.content else {}


def _reset_user(db, email: str, password: str, pro: bool, report: SeedReport):
    from app.models.user import User
    from app.services.auth import hash_password

    existing = db.query(User).filter(User.email == email).first()
    user_id = existing.id if existing else uuid.uuid4()
    if existing:
        report.log(f"Wipe existing demo account {email} (all its data cascades) and recreate it")
        if not report.dry_run:
            db.delete(existing)
            db.flush()
    else:
        report.log(f"Create demo account {email}")
    report.user_id = str(user_id)
    report.log(f"Tier: {'pro + partner' if pro else 'free'}; business name '{BUSINESS_NAME}'")
    if report.dry_run:
        return None
    user = User(
        id=user_id,
        email=email,
        password_hash=hash_password(password),
        business_name=BUSINESS_NAME,
        subscription_tier="pro" if pro else "free",
        is_partner=pro,
        sales_tax_rate=6.625,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def seed(db, email: str, password: str, *, dry_run: bool = False, pro: bool = True) -> SeedReport:
    """Seed the demo account using session ``db``. Returns what was done."""
    report = SeedReport(email=email, dry_run=dry_run, tier="pro" if pro else "free")
    user = _reset_user(db, email, password, pro, report)

    report.log(f"Add {len(ITEMS)} inventory items ({sum(1 for i in ITEMS if 'custom_attributes' in i)} with per-size stock)")
    report.log(f"Add {len(CUSTOMERS)} customers")
    report.log("Start a show 3 hours ago, then record 3 sales (one split cash + card, one tagged to a customer)")
    report.log("Create an invoice for Priya Shah and record a partial payment")
    if dry_run:
        report.items, report.customers, report.sales, report.invoices = len(ITEMS), len(CUSTOMERS), 3, 1
        return report

    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.main import app
    from app.rate_limit import limiter
    from app.services.auth import issue_session

    token, _, _ = issue_session(db, user.id)
    headers = {"Authorization": f"Bearer {token}"}

    def _db_override():
        yield db

    previous_override = app.dependency_overrides.get(get_db)
    previous_limiter = limiter.enabled
    app.dependency_overrides[get_db] = _db_override
    limiter.enabled = False
    try:
        client = TestClient(app)
        items = {}
        for spec in ITEMS:
            created = _check(client.post(f"{API}/inventory", json=spec, headers=headers), f"item {spec['sku']}")
            items[spec["sku"]] = created["id"]
        report.items = len(items)

        customers = {}
        for spec in CUSTOMERS:
            created = _check(client.post(f"{API}/customers", json=spec, headers=headers), f"customer {spec['name']}")
            customers[spec["name"]] = created["id"]
        report.customers = len(customers)

        started = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
        _check(client.put(f"{API}/dashboard/show-start", json={"started_at": started}, headers=headers), "show start")

        sales = [
            # Split payment: $300 + $150 = $450, tax-free for a clean demo.
            {"lines": [{"item_id": items["AJ1-LF"], "quantity": 1, "unit_price": "300.00", "size": "10"},
                       {"item_id": items["DUNK-PANDA"], "quantity": 1, "unit_price": "150.00", "size": "9"}],
             "payments": [{"method": "cash", "amount": "300.00"}, {"method": "card", "amount": "150.00"}],
             "notes": "Bundle deal"},
            {"lines": [{"item_id": items["VTG-BULLS-94"], "quantity": 1, "unit_price": "110.00"},
                       {"item_id": items["FOG-ESS-OAT"], "quantity": 1, "unit_price": "90.00", "size": "M"}],
             "method": "zelle", "customer_id": customers["Maya Rodriguez"]},
            {"lines": [{"item_id": items["PKM-151-BB"], "quantity": 2, "unit_price": "45.00"}],
             "method": "cash", "discount_amount": "10.00"},
        ]
        for index, sale in enumerate(sales, start=1):
            _check(client.post(f"{API}/transactions/order", json=sale, headers=headers), f"sale {index}")
        report.sales = len(sales)

        invoice = _check(client.post(f"{API}/invoices", json={
            "customer_id": customers["Priya Shah"],
            "customer_name": "Priya Shah",
            "customer_email": "priya.shah@example.com",
            "items": [
                {"inventory_item_id": items["VTG-HD-3D"], "description": "Vintage Harley-Davidson 3D Emblem Tee - L",
                 "quantity": 1, "unit_price": "90.00"},
                {"inventory_item_id": items["CAR-DET-BRN"], "size_label": "L",
                 "description": "Carhartt WIP Detroit Jacket - Size L", "quantity": 1, "unit_price": "170.00"},
            ],
            "notes": "Net 15. Thanks for the wholesale order!",
        }, headers=headers), "invoice")
        _check(client.post(f"{API}/invoices/{invoice['id']}/payments",
                           json={"amount": "100.00", "method": "venmo", "note": "Deposit"}, headers=headers),
               "invoice partial payment")
        report.invoices = 1
    finally:
        limiter.enabled = previous_limiter
        if previous_override is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous_override
    db.commit()
    report.log("Done.")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="Print what would happen; write nothing.")
    parser.add_argument("--free", action="store_true", help="Leave the reviewer on the free tier.")
    args = parser.parse_args(argv)

    email, password = read_credentials()
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        report = seed(db, email, password, dry_run=args.dry_run, pro=not args.free)
    finally:
        db.close()
    print(f"Demo account {report.email}: {report.items} items, {report.customers} customers, "
          f"{report.sales} sales, {report.invoices} invoice(s); tier {report.tier}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
