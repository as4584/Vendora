"""Invoice PDF branding — custom accent color + business contact info.

Pure unit tests (no DB) that exercise generate_invoice_pdf with lightweight
stand-ins, so they run without the Postgres test database.
"""
from datetime import datetime
from types import SimpleNamespace as NS

from app.services.invoice_pdf import _hex_to_rgb, generate_invoice_pdf


def _user(**over):
    base = dict(business_name="Acme Co", email="a@b.co", profile_picture=None,
                business_address="123 Main St, Town", business_phone="555-1212",
                invoice_accent_color=None)
    base.update(over)
    return NS(**base)


def _invoice(**over):
    base = dict(customer_name="Client X", customer_email="x@y.co", created_at=datetime(2026, 7, 1),
                subtotal=100.0, tax=7.0, shipping=0.0, discount=0.0, total=107.0, status="sent", notes="")
    base.update(over)
    return NS(**base)


_ITEMS = [NS(description="Job", size_label=None, quantity=2, unit_price=50.0, line_total=100.0)]


def test_hex_to_rgb():
    assert _hex_to_rgb("#3B7BDB") == (59, 123, 219)
    assert _hex_to_rgb("f26722") == (242, 103, 34)
    assert _hex_to_rgb(None) is None
    assert _hex_to_rgb("nope") is None
    assert _hex_to_rgb("#12345") is None


def test_generates_valid_pdf_default_and_custom():
    for color in (None, "#f26722", "#00A86B"):
        pdf = generate_invoice_pdf(_invoice(), _ITEMS, _user(invoice_accent_color=color), "INV0001")
        assert pdf[:4] == b"%PDF" and len(pdf) > 800


def test_accent_color_changes_output():
    blue = generate_invoice_pdf(_invoice(), _ITEMS, _user(invoice_accent_color="#3B7BDB"), "INV0001")
    orange = generate_invoice_pdf(_invoice(), _ITEMS, _user(invoice_accent_color="#f26722"), "INV0001")
    assert blue != orange  # the accent color actually affects the rendered PDF


def test_handles_missing_contact_and_bad_color():
    user = _user(business_address=None, business_phone=None, invoice_accent_color="not-a-color")
    pdf = generate_invoice_pdf(_invoice(notes="hi"), _ITEMS, user, "INV0009")
    assert pdf[:4] == b"%PDF"  # falls back to default accent, no crash without address/phone
