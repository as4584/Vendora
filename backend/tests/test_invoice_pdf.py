"""Invoice PDF rendering regressions across optional branding and totals."""
import base64
import os
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

from app.services.invoice_pdf import _load_profile_tmp, generate_invoice_pdf


def _invoice(**overrides):
    values = {
        "customer_name": "PDF Buyer",
        "customer_email": "buyer@example.com",
        "created_at": datetime(2026, 6, 30, tzinfo=timezone.utc),
        "subtotal": Decimal("45.00"),
        "tax": Decimal("3.60"),
        "shipping": Decimal("5.00"),
        "discount": Decimal("2.00"),
        "total": Decimal("51.60"),
        "status": "sent",
        "notes": "Thank you for your purchase.",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _item(**overrides):
    values = {
        "description": "Vintage Jacket\nLimited run",
        "size_label": "M",
        "quantity": 2,
        "unit_price": Decimal("22.50"),
        "line_total": Decimal("45.00"),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _user(**overrides):
    values = {
        "email": "seller@example.com",
        "business_name": "Vendora Test Shop",
        "profile_picture": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_generates_complete_unpaid_invoice_with_initials_and_optional_totals():
    output = generate_invoice_pdf(_invoice(), [_item()], _user(), "INV0042")
    assert output.startswith(b"%PDF")
    assert len(output) > 1_000


def test_generates_paid_minimal_invoice_without_optional_customer_fields():
    output = generate_invoice_pdf(
        _invoice(
            customer_email=None,
            created_at=None,
            tax=Decimal("0"),
            shipping=Decimal("0"),
            discount=Decimal("0"),
            status="paid",
            notes=None,
        ),
        [_item(description="Single line", size_label=None)],
        _user(business_name=None),
        "INV0001",
    )
    assert output.startswith(b"%PDF")


def test_profile_image_loader_handles_valid_raw_and_invalid_data():
    # Minimal valid JPEG bytes are sufficient for loader behavior; rendering
    # fallback is exercised separately when FPDF rejects them as an image.
    encoded = base64.b64encode(b"not-a-real-jpeg").decode()
    user = _user(profile_picture=f"data:image/jpeg;base64,{encoded}")
    path = _load_profile_tmp(user)
    assert path and os.path.exists(path)
    try:
        assert open(path, "rb").read() == b"not-a-real-jpeg"
    finally:
        os.unlink(path)

    assert _load_profile_tmp(_user(profile_picture="%%%invalid%%%")) is None
    assert _load_profile_tmp(_user(profile_picture=None)) is None


def test_invalid_profile_image_falls_back_to_initials_and_cleans_temp_file(monkeypatch):
    encoded = base64.b64encode(b"not-a-real-jpeg").decode()
    removed = []
    real_unlink = os.unlink

    def track_unlink(path):
        removed.append(path)
        real_unlink(path)

    monkeypatch.setattr("app.services.invoice_pdf.os.unlink", track_unlink)
    output = generate_invoice_pdf(
        _invoice(),
        [_item()],
        _user(profile_picture=f"data:image/jpeg;base64,{encoded}"),
        "INV0043",
    )
    assert output.startswith(b"%PDF")
    assert removed and not os.path.exists(removed[0])


def test_profile_cleanup_failure_does_not_break_pdf(monkeypatch):
    monkeypatch.setattr("app.services.invoice_pdf._load_profile_tmp", lambda user: "missing-image.jpg")
    monkeypatch.setattr(
        "app.services.invoice_pdf.os.unlink",
        lambda path: (_ for _ in ()).throw(OSError("locked")),
    )
    output = generate_invoice_pdf(_invoice(), [_item()], _user(), "INV0044")
    assert output.startswith(b"%PDF")
