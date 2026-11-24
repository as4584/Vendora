"""POST /api/v1/transactions/import/sales — marketplace sales CSVs."""
from datetime import datetime, timezone
from decimal import Decimal

from app.models.transaction import Transaction
from app.services.sales_import import detect_columns, parse_sales_csv

URL = "/api/v1/transactions/import/sales"

POSHMARK = (
    "Order Date,Listing Title,Order ID,Order Price,Net Earnings\n"
    "03/14/2026,Vintage Levi's 501,PM-1,$40.00,$32.00\n"
    "2026-04-02,Nike Hoodie,PM-2,25.00,20.05\n"
    ",,,,\n"
    "04/03/2026,Broken row,PM-3,,\n"
)
MERCARI = (
    "Item Title,Sold Date,Item Price,Mercari Selling Fee,Payment Processing Fee,Shipping Fee,Net Seller Proceeds\n"
    "Switch Game,2026-05-01,60.00,6.00,1.74,5.00,47.26\n"
)


def _post(client, headers, body, platform="poshmark", dry_run=True):
    return client.post(f"{URL}?platform={platform}&dry_run={'true' if dry_run else 'false'}", headers=headers,
                       files={"file": ("sales.csv", body.encode(), "text/csv")})


def test_detects_columns_and_fee_columns():
    mapping, fees = detect_columns(["Item Title", "Sold Date", "Item Price", "Mercari Selling Fee",
                                    "Payment Processing Fee", "Shipping Fee", "Net Seller Proceeds"])
    assert mapping == {"date": "Sold Date", "title": "Item Title", "gross": "Item Price", "net": "Net Seller Proceeds"}
    assert fees == ["Mercari Selling Fee", "Payment Processing Fee"]  # shipping isn't a selling fee


def test_fee_from_net_when_no_fee_columns():
    sales, errors, _ = parse_sales_csv(POSHMARK.encode())
    assert [s["fee"] for s in sales] == [Decimal("8.00"), Decimal("4.95")]
    assert sales[0]["date"] == datetime(2026, 3, 14, tzinfo=timezone.utc)
    assert errors == [{"row": 5, "reason": "No sale price."}]


def test_preview_then_import_then_no_duplicates(client, db, test_user, auth_headers):
    preview = _post(client, auth_headers, POSHMARK).json()
    assert preview["new_sales"] == 2 and preview["imported"] == 0
    assert preview["gross_total"] == "65.00" and preview["fee_total"] == "12.95"
    assert db.query(Transaction).filter_by(user_id=test_user.id).count() == 0

    done = _post(client, auth_headers, POSHMARK, dry_run=False).json()
    assert done["imported"] == 2
    rows = db.query(Transaction).filter_by(user_id=test_user.id, source="poshmark").order_by(Transaction.created_at).all()
    assert [r.external_reference_id for r in rows] == ["PM-1", "PM-2"]
    assert rows[0].net_amount == Decimal("32.00") and rows[0].method == "other"
    assert rows[0].created_at.date().isoformat() == "2026-03-14"
    assert "Vintage Levi's 501" in rows[0].notes

    again = _post(client, auth_headers, POSHMARK, dry_run=False).json()
    assert again["imported"] == 0 and again["duplicates"] == 2


def test_rows_without_ids_dedupe_by_content(client, db, test_user, auth_headers):
    _post(client, auth_headers, MERCARI, platform="mercari", dry_run=False)
    again = _post(client, auth_headers, MERCARI, platform="mercari", dry_run=False).json()
    assert again["duplicates"] == 1
    txn = db.query(Transaction).filter_by(user_id=test_user.id, source="mercari").one()
    assert txn.fee_amount == Decimal("7.74") and txn.external_reference_id.startswith("row:")


def test_reports_unusable_files_and_validates_platform(client, auth_headers):
    body = _post(client, auth_headers, "Foo,Bar\n1,2\n").json()
    assert body["new_sales"] == 0 and "sale price column" in body["errors"][0]["reason"]
    assert _post(client, auth_headers, POSHMARK, platform="amazon").status_code == 422


def test_requires_auth(client):
    r = client.post(f"{URL}?platform=poshmark", files={"file": ("s.csv", b"x", "text/csv")})
    assert r.status_code == 401
