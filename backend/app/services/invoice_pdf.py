"""Invoice PDF generation service.

Generates a styled A4 invoice PDF that matches Resqlo's visual design —
white background, blue table header, black BALANCE DUE footer, user
profile picture (or initials circle) in the top-left corner.

Requires: fpdf2
"""
import base64
import os
import tempfile
from datetime import datetime
from decimal import Decimal
from typing import Optional

from fpdf import FPDF

from app.models.invoice import Invoice
from app.models.user import User

# ─── Colour palette ──────────────────────────────────────────────────────────
BLUE       = (59, 123, 219)       # table header / initials circle
DARK       = (30, 30, 30)         # primary text
MID        = (110, 110, 110)      # secondary / label text
WHITE      = (255, 255, 255)
BLACK      = (0, 0, 0)
BLUE_LBL   = (68, 114, 196)       # metadata key colour (default; overridden by accent)
LIGHT_LINE = (220, 220, 220)      # separator / row divider lines


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _hex_to_rgb(value: Optional[str]) -> Optional[tuple]:
    """'#3B7BDB' -> (59, 123, 219). Returns None on missing/invalid input."""
    if not value:
        return None
    v = value.strip().lstrip("#")
    if len(v) != 6:
        return None
    try:
        return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))
    except ValueError:
        return None

def _load_profile_tmp(user: User) -> Optional[str]:
    """Decode base64 profile_picture to a temp .jpg file. Returns path or None."""
    if not getattr(user, "profile_picture", None):
        return None
    try:
        data: str = user.profile_picture
        if "," in data:
            data = data.split(",", 1)[1]
        img_bytes = base64.b64decode(data)
        tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        tmp.write(img_bytes)
        tmp.close()
        return tmp.name
    except Exception:
        return None


def _draw_initials_circle(pdf: FPDF, x: float, y: float, size: float, user: User,
                          color: tuple = BLUE) -> None:
    """Accent-filled circle with up to 2 business initials as a fallback logo."""
    pdf.set_fill_color(*color)
    pdf.ellipse(x, y, size, size, style="F")
    name = user.business_name or user.email.split("@")[0]
    initials = "".join(w[0].upper() for w in name.split()[:2]) or "V"
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_text_color(*WHITE)
    iw = pdf.get_string_width(initials)
    pdf.set_xy(x + (size - iw) / 2 - 1, y + size / 2 - 3.5)
    pdf.cell(iw + 2, 7, initials, align="C")


def _draw_brand_header(pdf: FPDF, user: User, accent: tuple, heading: str,
                       L: float, T: float, W: float) -> float:
    """Logo, business name/contact (left) and a big heading (right).

    Shared by invoices and sale receipts. Returns the y of the separator line.
    """
    # ── Logo / profile picture (the business icon) ────────────────────────────
    pic_size: float = 22
    tmp_path = _load_profile_tmp(user)
    if tmp_path:
        try:
            pdf.image(tmp_path, x=L, y=T, w=pic_size, h=pic_size)
        except Exception:
            _draw_initials_circle(pdf, L, T, pic_size, user, accent)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    else:
        _draw_initials_circle(pdf, L, T, pic_size, user, accent)

    # Business name (below logo)
    biz = (user.business_name or user.email.split("@")[0])[:40]
    name_y: float = T + pic_size + 2
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(*DARK)
    pdf.set_xy(L, name_y)
    pdf.cell(W / 2, 5, biz, align="L")

    # Business contact lines (address / phone / email) — customizable branding
    contact_lines = [
        str(c).replace("\n", ", ")[:60]
        for c in (getattr(user, "business_address", None), getattr(user, "business_phone", None), user.email)
        if c
    ]
    cy: float = name_y + 5
    pdf.set_font("Helvetica", "", 8)
    pdf.set_text_color(*MID)
    for line in contact_lines[:3]:
        pdf.set_xy(L, cy)
        pdf.cell(W / 2, 4, line, align="L")
        cy += 4

    # Heading, e.g. "INVOICE" / "RECEIPT" (right side, large)
    pdf.set_font("Helvetica", "B", 28)
    pdf.set_text_color(*DARK)
    pdf.set_xy(L + W / 2, T)
    pdf.cell(W / 2, 12, heading, align="R")

    # ── Separator (adapts to the contact block height) ────────────────────────
    y_sep: float = max(cy + 2, T + pic_size + 9)
    pdf.set_draw_color(*LIGHT_LINE)
    pdf.line(L, y_sep, L + W, y_sep)

    return y_sep


# ─── Main generator ──────────────────────────────────────────────────────────

def generate_invoice_pdf(
    invoice: Invoice,
    items: list,
    user: User,
    inv_number: str,
) -> bytes:
    """Return PDF bytes for the given invoice.

    Args:
        invoice:    Invoice ORM object.
        items:      List of InvoiceItem ORM objects for this invoice.
        user:       The invoice owner (seller).
        inv_number: Human-readable invoice number, e.g. 'INV0005'.
    """
    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=False)
    pdf.add_page()

    L: float = 20      # left margin
    T: float = 15      # top margin
    W: float = 170     # usable width  (A4 210 − 2×20)

    # Per-business accent colour (falls back to Resqlo blue).
    accent = _hex_to_rgb(getattr(user, "invoice_accent_color", None)) or BLUE

    # ── Top accent bar (full width) ───────────────────────────────────────────
    pdf.set_fill_color(*accent)
    pdf.rect(0, 0, 210, 4, style="F")

    y_sep = _draw_brand_header(pdf, user, accent, "INVOICE", L, T, W)

    # ── Bill To + Invoice metadata ────────────────────────────────────────────
    y_meta: float = y_sep + 6

    # "BILL TO:" label
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(*accent)
    pdf.set_xy(L, y_meta)
    pdf.cell(18, 5, "BILL TO:", align="L")

    # Customer name
    pdf.set_font("Helvetica", "B", 13)
    pdf.set_text_color(*DARK)
    pdf.set_xy(L + 18, y_meta - 1)
    pdf.cell(W * 0.45, 7, invoice.customer_name, align="L")

    # Customer email (optional)
    if invoice.customer_email:
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(*MID)
        pdf.set_xy(L, y_meta + 8)
        pdf.cell(W * 0.45, 5, invoice.customer_email, align="L")

    # Right-column metadata (NUMBER / DATE / DUE DATE)
    created_str = (
        invoice.created_at.strftime("%b %d, %Y")
        if getattr(invoice, "created_at", None)
        else datetime.now().strftime("%b %d, %Y")
    )
    meta_rows = [
        ("NUMBER:", inv_number),
        ("DATE:", created_str),
        ("DUE DATE:", "On receipt"),
    ]
    rx: float = L + W * 0.52
    lbl_w: float = 24
    val_w: float = (L + W) - rx - lbl_w  # fills exactly to right margin
    for i, (label, value) in enumerate(meta_rows):
        ry = y_meta + i * 7
        pdf.set_font("Helvetica", "B", 8)
        pdf.set_text_color(*accent)
        pdf.set_xy(rx, ry)
        pdf.cell(lbl_w, 5, label, align="L")
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(*DARK)
        pdf.set_xy(rx + lbl_w, ry)
        pdf.cell(val_w, 5, value, align="L")

    # ── Table header ──────────────────────────────────────────────────────────
    y_table: float = y_meta + 26
    hdr_h: float = 9
    col_w = [W * 0.50, W * 0.15, W * 0.175, W * 0.175]
    col_labels = ["Description", "Quantity", "Unit price", "Amount"]
    col_aligns = ["L", "C", "R", "R"]

    pdf.set_fill_color(*accent)
    pdf.rect(L, y_table, W, hdr_h, style="F")

    x = L
    for cw, cl, ca in zip(col_w, col_labels, col_aligns):
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*WHITE)
        pdf.set_xy(x + 2, y_table + 2)
        pdf.cell(cw - 2, 5, cl, align=ca)
        x += cw

    # ── Line items ────────────────────────────────────────────────────────────
    y_row: float = y_table + hdr_h
    row_h: float = 11
    pdf.set_draw_color(*LIGHT_LINE)

    for item in items:
        desc_full = str(item.description or "")
        if getattr(item, "size_label", None):
            desc_full = f"{desc_full}\nSize: {item.size_label}"
        parts     = desc_full.split("\n", 1)
        main_desc = parts[0]
        sub_desc  = parts[1].strip() if len(parts) > 1 else ""

        # Main description (bold)
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(*DARK)
        pdf.set_xy(L + 2, y_row + 2)
        pdf.cell(col_w[0] - 4, 5, main_desc, align="L")

        # Sub-description (grey, smaller) — second line of description
        if sub_desc:
            pdf.set_font("Helvetica", "", 8)
            pdf.set_text_color(*MID)
            pdf.set_xy(L + 2, y_row + 7)
            pdf.cell(col_w[0] - 4, 4, sub_desc, align="L")

        # Quantity
        pdf.set_font("Helvetica", "", 10)
        pdf.set_text_color(*DARK)
        pdf.set_xy(L + col_w[0], y_row + 2)
        pdf.cell(col_w[1] - 2, 5, str(item.quantity), align="C")

        # Unit price
        pdf.set_xy(L + col_w[0] + col_w[1], y_row + 2)
        pdf.cell(col_w[2] - 2, 5, f"${float(item.unit_price):.2f}", align="R")

        # Line total
        pdf.set_xy(L + col_w[0] + col_w[1] + col_w[2], y_row + 2)
        pdf.cell(col_w[3] - 2, 5, f"${float(item.line_total):.2f}", align="R")

        y_row += row_h
        pdf.line(L, y_row, L + W, y_row)

    # ── Totals ────────────────────────────────────────────────────────────────
    y_totals: float = y_row + 8
    tx: float = L + W * 0.55
    tl: float = W * 0.26   # label column width
    tv: float = W * 0.19   # value column width

    def _trow(label: str, value: str, y: float) -> None:
        pdf.set_font("Helvetica", "", 10)
        pdf.set_text_color(*MID)
        pdf.set_xy(tx, y)
        pdf.cell(tl, 6, label, align="R")
        pdf.set_text_color(*DARK)
        pdf.set_xy(tx + tl, y)
        pdf.cell(tv, 6, value, align="R")

    # Recorded payments are the source of truth; legacy "paid" rows predate
    # amount_paid and count as paid in full.
    recorded = getattr(invoice, "amount_paid", None)
    paid_amt: float = float(recorded or 0)
    if invoice.status == "paid" and paid_amt == 0:
        paid_amt = float(invoice.total)
    balance:  float = max(float(invoice.total) - paid_amt, 0.0)

    dy: float = 0
    _trow("SUBTOTAL:", f"${float(invoice.subtotal):.2f}", y_totals + dy)
    dy += 7
    if float(invoice.tax) > 0:
        _trow("TAX:", f"${float(invoice.tax):.2f}", y_totals + dy)
        dy += 7
    if float(invoice.shipping) > 0:
        _trow("SHIPPING:", f"${float(invoice.shipping):.2f}", y_totals + dy)
        dy += 7
    if float(invoice.discount) > 0:
        _trow("DISCOUNT:", f"-${float(invoice.discount):.2f}", y_totals + dy)
        dy += 7
    _trow("TOTAL:", f"${float(invoice.total):.2f}", y_totals + dy)
    dy += 7
    _trow("PAID:", f"${paid_amt:.2f}", y_totals + dy)
    dy += 7

    # ── BALANCE DUE bar ───────────────────────────────────────────────────────
    y_bal: float = y_totals + dy + 6
    bar_h: float = 12
    pdf.set_fill_color(*BLACK)
    pdf.rect(L, y_bal, W, bar_h, style="F")

    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(*WHITE)
    pdf.set_xy(L + 4, y_bal + 2.5)
    pdf.cell(W * 0.6, 7, "BALANCE DUE", align="L")
    pdf.set_xy(L + W * 0.6, y_bal + 2.5)
    pdf.cell(W * 0.4, 7, f"${balance:.2f}", align="R")

    # ── Notes ─────────────────────────────────────────────────────────────────
    if invoice.notes:
        pdf.set_xy(L, y_bal + bar_h + 6)
        pdf.set_font("Helvetica", "I", 9)
        pdf.set_text_color(*MID)
        pdf.multi_cell(W, 5, f"Notes: {invoice.notes}")

    return bytes(pdf.output())


# ─── Sale receipt ────────────────────────────────────────────────────────────

PAYMENT_LABELS = {
    "cash": "Cash", "card": "Card", "venmo": "Venmo", "zelle": "Zelle",
    "cashapp": "Cash App", "paypal": "PayPal", "apple_pay": "Apple Pay", "split": "Split",
}


def _latin1(text: str) -> str:
    """The core PDF fonts are Latin-1 only; swap anything else for '?'."""
    return str(text).encode("latin-1", "replace").decode("latin-1")


def _money_str(value) -> str:
    amount = Decimal(value or 0).quantize(Decimal("0.01"))
    sign = "-" if amount < 0 else ""
    return f"{sign}${abs(amount):,.2f}"


def generate_receipt_pdf(
    *,
    user: User,
    receipt_number: str,
    created_at: Optional[datetime],
    lines: list[dict],
    subtotal,
    discount,
    tax,
    total,
    payments: list[dict],
) -> bytes:
    """Return PDF bytes for an in-person sale receipt.

    Same look as the invoice (accent bar, logo/initials, business block) so a
    seller's paperwork matches; the footer credits Resqlo.

    lines:    [{"name", "size", "quantity", "unit_price", "line_total"}]
    payments: [{"method", "amount"}]
    """
    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=False)
    pdf.add_page()
    L, T, W = 20.0, 15.0, 170.0
    accent = _hex_to_rgb(getattr(user, "invoice_accent_color", None)) or BLUE

    pdf.set_fill_color(*accent)
    pdf.rect(0, 0, 210, 4, style="F")
    y_sep = _draw_brand_header(pdf, user, accent, "RECEIPT", L, T, W)

    when = (created_at or datetime.now()).strftime("%b %d, %Y %I:%M %p")
    y = y_sep + 6
    for label, value in (("RECEIPT:", receipt_number), ("DATE:", when)):
        pdf.set_font("Helvetica", "B", 8)
        pdf.set_text_color(*accent)
        pdf.set_xy(L, y)
        pdf.cell(22, 5, label, align="L")
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(*DARK)
        pdf.set_xy(L + 22, y)
        pdf.cell(W - 22, 5, _latin1(value), align="L")
        y += 6

    def _table_header() -> None:
        nonlocal y
        pdf.set_fill_color(*accent)
        pdf.rect(L, y, W, 9, style="F")
        x = L
        for cw, label, align in zip(col_w, ["Item", "Qty", "Price", "Amount"], ["L", "C", "R", "R"]):
            pdf.set_font("Helvetica", "B", 9)
            pdf.set_text_color(*WHITE)
            pdf.set_xy(x + 2, y + 2)
            pdf.cell(cw - 2, 5, label, align=align)
            x += cw
        y += 9

    col_w = [W * 0.50, W * 0.15, W * 0.175, W * 0.175]
    y += 4
    _table_header()
    for line in lines:
        if y > 255:
            pdf.add_page()
            y = T
            _table_header()
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(*DARK)
        pdf.set_xy(L + 2, y + 2)
        pdf.cell(col_w[0] - 4, 5, _latin1(line.get("name") or "Item")[:60], align="L")
        if line.get("size"):
            pdf.set_font("Helvetica", "", 8)
            pdf.set_text_color(*MID)
            pdf.set_xy(L + 2, y + 7)
            pdf.cell(col_w[0] - 4, 4, _latin1(f"Size: {line['size']}"), align="L")
        pdf.set_font("Helvetica", "", 10)
        pdf.set_text_color(*DARK)
        pdf.set_xy(L + col_w[0], y + 2)
        pdf.cell(col_w[1] - 2, 5, str(line.get("quantity") or 1), align="C")
        pdf.set_xy(L + col_w[0] + col_w[1], y + 2)
        pdf.cell(col_w[2] - 2, 5, _money_str(line.get("unit_price")), align="R")
        pdf.set_xy(L + col_w[0] + col_w[1] + col_w[2], y + 2)
        pdf.cell(col_w[3] - 2, 5, _money_str(line.get("line_total")), align="R")
        y += 11
        pdf.set_draw_color(*LIGHT_LINE)
        pdf.line(L, y, L + W, y)

    rows = [("SUBTOTAL:", _money_str(subtotal), False)]
    if Decimal(discount or 0) > 0:
        rows.append(("DISCOUNT:", _money_str(-Decimal(discount)), False))
    if Decimal(tax or 0) > 0:
        rows.append(("TAX:", _money_str(tax), False))
    rows.append(("TOTAL:", _money_str(total), True))
    for part in payments:
        method = part.get("method") or ""
        rows.append((f"PAID ({PAYMENT_LABELS.get(method, method).upper()}):", _money_str(part.get("amount")), False))
    if y + 8 + len(rows) * 7 + 40 > 290:
        pdf.add_page()
        y = T

    tx, tl, tv = L + W * 0.45, W * 0.36, W * 0.19
    y += 8
    for label, value, bold in rows:
        pdf.set_font("Helvetica", "B" if bold else "", 10)
        pdf.set_text_color(*(DARK if bold else MID))
        pdf.set_xy(tx, y)
        pdf.cell(tl, 6, _latin1(label), align="R")
        pdf.set_text_color(*DARK)
        pdf.set_xy(tx + tl, y)
        pdf.cell(tv, 6, value, align="R")
        y += 7

    y += 6
    pdf.set_fill_color(*BLACK)
    pdf.rect(L, y, W, 12, style="F")
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(*WHITE)
    pdf.set_xy(L + 4, y + 2.5)
    pdf.cell(W * 0.6, 7, "PAID", align="L")
    pdf.set_xy(L + W * 0.6, y + 2.5)
    pdf.cell(W * 0.4 - 4, 7, _money_str(total), align="R")
    y += 20

    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(*MID)
    pdf.set_xy(L, y)
    pdf.cell(W, 5, "Thank you!", align="C")
    pdf.set_font("Helvetica", "", 7)
    pdf.set_xy(L, y + 6)
    pdf.cell(W, 4, "Receipt by Resqlo", align="C")

    return bytes(pdf.output())
