"""Invoice PDF generation service.

Generates a styled A4 invoice PDF that matches Vendora's visual design —
white background, blue table header, black BALANCE DUE footer, user
profile picture (or initials circle) in the top-left corner.

Requires: fpdf2
"""
import base64
import os
import tempfile
from datetime import datetime
from typing import Optional

from fpdf import FPDF

from app.models.invoice import Invoice, InvoiceItem
from app.models.user import User

# ─── Colour palette ──────────────────────────────────────────────────────────
BLUE       = (59, 123, 219)       # table header / initials circle
DARK       = (30, 30, 30)         # primary text
MID        = (110, 110, 110)      # secondary / label text
WHITE      = (255, 255, 255)
BLACK      = (0, 0, 0)
BLUE_LBL   = (68, 114, 196)       # metadata key colour
LIGHT_LINE = (220, 220, 220)      # separator / row divider lines


# ─── Helpers ─────────────────────────────────────────────────────────────────

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


def _draw_initials_circle(pdf: FPDF, x: float, y: float, size: float, user: User) -> None:
    """Blue filled circle with up to 2 business initials as a fallback logo."""
    pdf.set_fill_color(*BLUE)
    pdf.ellipse(x, y, size, size, style="F")
    name = user.business_name or user.email.split("@")[0]
    initials = "".join(w[0].upper() for w in name.split()[:2]) or "V"
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_text_color(*WHITE)
    iw = pdf.get_string_width(initials)
    pdf.set_xy(x + (size - iw) / 2 - 1, y + size / 2 - 3.5)
    pdf.cell(iw + 2, 7, initials, align="C")


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

    # ── Logo / profile picture ────────────────────────────────────────────────
    pic_size: float = 22
    tmp_path = _load_profile_tmp(user)
    if tmp_path:
        try:
            pdf.image(tmp_path, x=L, y=T, w=pic_size, h=pic_size)
        except Exception:
            _draw_initials_circle(pdf, L, T, pic_size, user)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    else:
        _draw_initials_circle(pdf, L, T, pic_size, user)

    # Business name (below logo)
    biz = (user.business_name or user.email.split("@")[0])[:40]
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(*DARK)
    pdf.set_xy(L, T + pic_size + 2)
    pdf.cell(W / 2, 5, biz, align="L")

    # "INVOICE" heading (right side, large)
    pdf.set_font("Helvetica", "B", 28)
    pdf.set_text_color(*DARK)
    pdf.set_xy(L + W / 2, T)
    pdf.cell(W / 2, 12, "INVOICE", align="R")

    # ── Separator ─────────────────────────────────────────────────────────────
    y_sep: float = T + pic_size + 9
    pdf.set_draw_color(*LIGHT_LINE)
    pdf.line(L, y_sep, L + W, y_sep)

    # ── Bill To + Invoice metadata ────────────────────────────────────────────
    y_meta: float = y_sep + 6

    # "BILL TO:" label
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(*BLUE_LBL)
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
        pdf.set_text_color(*BLUE_LBL)
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

    pdf.set_fill_color(*BLUE)
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

    paid_amt: float = float(invoice.total) if invoice.status == "paid" else 0.0
    balance:  float = float(invoice.total) - paid_amt

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
