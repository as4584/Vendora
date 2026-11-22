"""Price labels / hang tags as a printable PDF.

Layouts
-------
- ``thermal``: one 2.25" x 1.25" label per page — Rollo, Dymo, Zebra and
  Brother label printers via AirPrint / the share sheet.
- ``sheet``: US Letter, Avery 5160/8160 (3 x 10, 2.625" x 1").

Each label shows the name, size/condition, the price large, and a QR code
(``resqlo:item:<id>``) that the Quick Sale scanner adds to the cart. QR stays
crisp at thermal-printer resolution, where a linear barcode of a UPC would
need bars thinner than one printer dot.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, Literal, Optional

import segno
from fpdf import FPDF

from app.models.inventory import InventoryItem

Layout = Literal["thermal", "sheet"]
MAX_LABELS = 600
QR_PREFIX = "resqlo:item:"


@dataclass(frozen=True)
class Label:
    name: str
    detail: str
    price: str
    qr: str
    code: Optional[str] = None  # human-readable UPC/SKU beside the QR


def _latin1(text: str) -> str:
    """Core PDF fonts are Latin-1; swap the usual offenders, drop the rest."""
    for bad, good in (("’", "'"), ("‘", "'"), ("“", '"'), ("”", '"'),
                      ("–", "-"), ("—", "-"), ("×", "x")):
        text = text.replace(bad, good)
    return text.encode("latin-1", "ignore").decode("latin-1").strip()


def printed_code(item: InventoryItem) -> Optional[str]:
    """UPC, else SKU, as short printable text."""
    for raw in (item.upc, item.sku):
        if raw and raw.strip():
            return _latin1(raw.strip())[:24] or None
    return None


def label_for(item: InventoryItem) -> Label:
    price = item.expected_sell_price
    detail = " - ".join(p for p in (f"Size {item.size}" if item.size else "", item.condition or "") if p)
    return Label(
        name=_latin1(item.name or "Item") or "Item",
        detail=_latin1(detail),
        price=f"${Decimal(price):,.2f}" if price is not None else "",
        qr=f"{QR_PREFIX}{item.id}",
        code=printed_code(item),
    )


def expand(items: Iterable[InventoryItem], per_unit: bool) -> list[Label]:
    labels: list[Label] = []
    for item in items:
        copies = max(1, item.quantity or 1) if per_unit else 1
        labels.extend([label_for(item)] * copies)
    return labels[:MAX_LABELS]


def _qr(pdf: FPDF, data: str, x: float, y: float, side: float) -> None:
    """Vector QR: one filled run per row of dark modules (no images, prints sharp)."""
    matrix = [list(row) for row in segno.make_qr(data, error="m").matrix_iter(scale=1, border=0)]
    cell = side / len(matrix)
    pdf.set_fill_color(0, 0, 0)
    for r, row in enumerate(matrix):
        c = 0
        while c < len(row):
            if row[c]:
                start = c
                while c < len(row) and row[c]:
                    c += 1
                pdf.rect(x + start * cell, y + r * cell, (c - start) * cell, cell, style="F")
            else:
                c += 1


def _draw(pdf: FPDF, label: Label, x: float, y: float, w: float, h: float) -> None:
    pad = 0.08
    pdf.set_xy(x + pad, y + pad)
    pdf.set_font("Helvetica", "B", 9)
    pdf.multi_cell(w - 2 * pad, 0.15, label.name, align="L", max_line_height=0.15, new_x="LEFT", new_y="NEXT")
    if pdf.get_y() > y + pad + 0.32:  # two lines of name at most
        pdf.set_y(y + pad + 0.32)
    if label.detail:
        pdf.set_x(x + pad)
        pdf.set_font("Helvetica", "", 7)
        pdf.cell(w - 2 * pad, 0.13, label.detail)
    side = 0.5 if h >= 1.2 else 0.36
    qx, qy = x + pad, y + h - pad - side
    _qr(pdf, label.qr, qx, qy, side)
    if label.code:
        pdf.set_font("Helvetica", "", 6)
        pdf.set_xy(qx + side + 0.05, y + h - pad - 0.1)
        pdf.cell(0.8, 0.1, label.code)
    if label.price:
        pdf.set_font("Helvetica", "B", 16)
        pdf.set_xy(x + pad, y + h - pad - 0.42)
        pdf.cell(w - 2 * pad, 0.3, label.price, align="R")


def build_labels_pdf(labels: list[Label], layout: Layout) -> bytes:
    if layout == "thermal":
        w, h = 2.25, 1.25
        pdf = FPDF(unit="in", format=(w, h))
    else:
        w, h = 2.625, 1.0
        pdf = FPDF(unit="in", format="letter")
    pdf.set_auto_page_break(False)
    pdf.set_margins(0, 0)
    pdf.set_title("Resqlo price labels")
    if layout == "thermal":
        for label in labels:
            pdf.add_page()
            _draw(pdf, label, 0, 0, w, h)
    else:
        cols, rows, left, top, gap = 3, 10, 0.1875, 0.5, 0.125
        for index, label in enumerate(labels):
            slot = index % (cols * rows)
            if slot == 0:
                pdf.add_page()
            _draw(pdf, label, left + (slot % cols) * (w + gap), top + (slot // cols) * h, w, h)
    if not labels:
        pdf.add_page()
    return bytes(pdf.output())
