"""App Review demo account seeder: dry-run safety, data shape, idempotency."""
import pytest

from app.models.customer import Customer
from app.models.inventory import InventoryItem
from app.models.invoice import Invoice
from app.models.transaction import Transaction
from app.models.user import User
from scripts import seed_review_account as seeder

EMAIL = "appreview-test@resqlo.example"
PASSWORD = "Review-Demo-Pass-123"


def _user(db):
    return db.query(User).filter(User.email == EMAIL).first()


def test_requires_email_and_password_from_env():
    with pytest.raises(SystemExit):
        seeder.read_credentials({})
    with pytest.raises(SystemExit):
        seeder.read_credentials({"REVIEW_ACCOUNT_EMAIL": EMAIL, "REVIEW_ACCOUNT_PASSWORD": "short"})
    assert seeder.read_credentials(
        {"REVIEW_ACCOUNT_EMAIL": " AppReview-Test@Resqlo.example ", "REVIEW_ACCOUNT_PASSWORD": PASSWORD}
    ) == (EMAIL, PASSWORD)


def test_no_secrets_hardcoded():
    source = open(seeder.__file__, encoding="utf-8").read()
    assert "REVIEW_ACCOUNT_PASSWORD" in source
    assert "password=" not in source.replace("password=hash_password(password)", "")


def test_dry_run_writes_nothing(db, capsys):
    report = seeder.seed(db, EMAIL, PASSWORD, dry_run=True)
    assert _user(db) is None
    assert report.items == 15 and report.customers == 3 and report.sales == 3 and report.invoices == 1
    assert "[dry-run]" in capsys.readouterr().out


def test_seed_creates_realistic_pro_dataset_and_is_idempotent(db):
    first = seeder.seed(db, EMAIL, PASSWORD)
    user = _user(db)
    assert user is not None and user.subscription_tier == "pro" and user.is_partner
    assert user.show_started_at is not None

    def counts(uid):
        return (
            db.query(InventoryItem).filter(InventoryItem.user_id == uid).count(),
            db.query(Customer).filter(Customer.user_id == uid).count(),
            db.query(Invoice).filter(Invoice.user_id == uid).count(),
            db.query(Transaction).filter(Transaction.user_id == uid).count(),
        )

    before = counts(user.id)
    assert before[0] == 15 and before[1] == 3 and before[2] == 1 and before[3] >= 5
    invoice = db.query(Invoice).filter(Invoice.user_id == user.id).one()
    assert invoice.status == "partially_paid"

    from app.services.auth import verify_password
    assert verify_password(PASSWORD, user.password_hash)

    second = seeder.seed(db, EMAIL, PASSWORD)
    db.expire_all()
    again = _user(db)
    assert again.id == user.id == uuid_of(first) == uuid_of(second)
    assert counts(again.id) == before


def uuid_of(report):
    import uuid
    return uuid.UUID(report.user_id)


def test_free_flag_leaves_reviewer_on_free_tier(db):
    seeder.seed(db, EMAIL, PASSWORD, pro=False)
    user = _user(db)
    assert user.subscription_tier == "free" and not user.is_partner


def test_main_dry_run(monkeypatch, capsys):
    monkeypatch.setenv("REVIEW_ACCOUNT_EMAIL", EMAIL)
    monkeypatch.setenv("REVIEW_ACCOUNT_PASSWORD", PASSWORD)
    assert seeder.main(["--dry-run"]) == 0
    assert "15 items" in capsys.readouterr().out
