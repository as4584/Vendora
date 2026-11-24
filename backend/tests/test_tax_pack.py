"""Year-end tax pack: GET /export/tax-summary and /export/tax-pack."""
from datetime import datetime, timezone
from decimal import Decimal

from app.models.inventory import InventoryItem
from app.models.transaction import Transaction

YEAR = datetime.now(timezone.utc).year


def _txn(db, user, month, gross, fee="0", cost=None, source=None, refund=False, item=None):
    t = Transaction(
        user_id=user.id, method="card", gross_amount=Decimal(gross), fee_amount=Decimal(fee),
        net_amount=Decimal(gross) - Decimal(fee), source=source, is_refund=refund,
        cost_amount=None if cost is None else Decimal(cost), item_id=item.id if item else None,
    )
    db.add(t)
    db.flush()
    t.created_at = datetime(YEAR, month, 15, tzinfo=timezone.utc)
    db.flush()
    return t


def _pro(db, user):
    user.subscription_tier = "pro"
    db.flush()


def test_summary_totals_months_and_channels(client, db, test_user, auth_headers):
    _pro(db, test_user)
    lamp = InventoryItem(user_id=test_user.id, name="Lamp")
    db.add(lamp)
    db.flush()
    _txn(db, test_user, 1, "100", fee="13.60", cost="40", source="ebay", item=lamp)
    _txn(db, test_user, 1, "50", cost="20")
    _txn(db, test_user, 2, "30")  # no cost recorded
    _txn(db, test_user, 2, "-50", cost="-20", refund=True)
    body = client.get("/api/v1/export/tax-summary", headers=auth_headers).json()
    assert body["year"] == YEAR
    assert Decimal(body["gross_sales"]) == Decimal("180")
    assert Decimal(body["refunds"]) == Decimal("50")
    assert Decimal(body["fees"]) == Decimal("13.60")
    assert Decimal(body["cost_of_goods"]) == Decimal("40")
    # (86.40 - 40) + (50 - 20) + 30 + (-50 + 20)
    assert Decimal(body["net_profit"]) == Decimal("76.40")
    assert body["sales_count"] == 3 and body["sales_missing_cost"] == 1
    assert Decimal(body["by_month"][0]["gross_sales"]) == Decimal("150")
    channels = {c["channel"]: c for c in body["by_channel"]}
    assert channels["ebay"]["label"] == "eBay" and Decimal(channels["ebay"]["gross_sales"]) == Decimal("100")
    assert Decimal(channels["in_app"]["gross_sales"]) == Decimal("80")


def test_csv_has_sections_and_lines(client, db, test_user, auth_headers):
    _pro(db, test_user)
    lamp = InventoryItem(user_id=test_user.id, name="Brass Lamp")
    db.add(lamp)
    db.flush()
    _txn(db, test_user, 3, "75", fee="5", cost="25", source="ebay", item=lamp)
    r = client.get(f"/api/v1/export/tax-pack?year={YEAR}", headers=auth_headers)
    assert r.status_code == 200
    assert f"resqlo_tax_pack_{YEAR}.csv" in r.headers["content-disposition"]
    text = r.content.decode("utf-8-sig")
    for section in ("Summary", "By channel", "By month", "Sales"):
        assert section in text
    assert "Net profit,45.00" in text
    assert f"{YEAR}-03-15,Brass Lamp,eBay,Sale,1,75.00,5.00,70.00,25.00" in text


def test_excludes_other_years_and_users(client, db, test_user, second_user, auth_headers):
    _pro(db, test_user)
    old = _txn(db, test_user, 6, "999")
    old.created_at = datetime(YEAR - 1, 6, 1, tzinfo=timezone.utc)
    _txn(db, second_user, 6, "500")
    db.flush()
    body = client.get("/api/v1/export/tax-summary", headers=auth_headers).json()
    assert Decimal(body["gross_sales"]) == 0
    last = client.get(f"/api/v1/export/tax-summary?year={YEAR - 1}", headers=auth_headers).json()
    assert Decimal(last["gross_sales"]) == Decimal("999")


def test_pro_only_and_valid_year(client, db, test_user, auth_headers):
    assert client.get("/api/v1/export/tax-summary", headers=auth_headers).status_code == 403
    _pro(db, test_user)
    assert client.get(f"/api/v1/export/tax-summary?year={YEAR + 1}", headers=auth_headers).status_code == 400
