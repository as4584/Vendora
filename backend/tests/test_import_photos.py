"""Spreadsheet photos come across with the items: floating pictures and
Excel 365 "Place in Cell" pictures, matched to their rows."""
import io
import zipfile

from openpyxl import Workbook
from PIL import Image

from app.services import spreadsheet_import as si

RICH = "http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"
MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _png(color) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (900, 700), color).save(buf, format="PNG")
    return buf.getvalue()


def _in_cell_xlsx(photo_rows: dict[int, int], images: int = 2, broken_vm: bool = False) -> bytes:
    """A workbook whose Photo column (D) holds in-cell pictures, built the way Excel 365 saves them.

    ``photo_rows`` maps a sheet row to the picture index placed in D<row>.
    """
    wb = Workbook()
    ws = wb.active
    ws.append(["Product Name", "SKU", "Qty", "Photo"])
    ws.append(["Dunk Low", "DL-1", 1, None])
    ws.append(["Jordan 4", "J4-1", 2, None])
    ws.append(["No photo", "NP-1", 1, None])
    out = io.BytesIO()
    wb.save(out)

    src = zipfile.ZipFile(io.BytesIO(out.getvalue()))
    dst_buf = io.BytesIO()
    dst = zipfile.ZipFile(dst_buf, "w", zipfile.ZIP_DEFLATED)
    for info in src.infolist():
        data = src.read(info.filename)
        if info.filename == "xl/worksheets/sheet1.xml":
            text = data.decode()
            for row, rv in photo_rows.items():
                vm = 99 if broken_vm else rv + 1
                cell = f'<c r="D{row}" t="e" vm="{vm}"><v>#VALUE!</v></c>'
                marker = f'<c r="C{row}"'
                end = text.index("</c>", text.index(marker)) + 4
                text = text[:end] + cell + text[end:]
            data = text.encode()
        dst.writestr(info, data)

    value_bks = "".join(f'<bk><rc t="1" v="{i}"/></bk>' for i in range(images))
    future_bks = "".join(
        f'<bk><extLst><ext uri="x"><xlrd:rvb i="{i}"/></ext></extLst></bk>' for i in range(images)
    )
    dst.writestr("xl/metadata.xml", (
        f'<metadata xmlns="{MAIN}" xmlns:xlrd="{RICH}">'
        '<metadataTypes count="1"><metadataType name="XLRICHVALUE"/></metadataTypes>'
        f'<futureMetadata name="XLRICHVALUE" count="{images}">{future_bks}</futureMetadata>'
        f'<valueMetadata count="{images}">{value_bks}</valueMetadata></metadata>'
    ))
    dst.writestr("xl/richData/rdrichvaluestructure.xml", (
        f'<rvStructures xmlns="{RICH}" count="1"><s t="_localImage">'
        '<k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>'
    ))
    rvs = "".join(f'<rv s="0"><v>{i}</v><v>5</v></rv>' for i in range(images))
    dst.writestr("xl/richData/rdrichvalue.xml", f'<rvData xmlns="{RICH}" count="{images}">{rvs}</rvData>')
    rels = "".join(f'<rel r:id="rId{i + 1}"/>' for i in range(images))
    dst.writestr("xl/richData/richValueRel.xml", (
        f'<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" '
        f'xmlns:r="{R}">{rels}</richValueRels>'
    ))
    targets = "".join(
        f'<Relationship Id="rId{i + 1}" Type="{R}/image" Target="../media/image{i + 1}.png"/>'
        for i in range(images)
    )
    dst.writestr("xl/richData/_rels/richValueRel.xml.rels", (
        f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{targets}</Relationships>'
    ))
    for i in range(images):
        dst.writestr(f"xl/media/image{i + 1}.png", _png((40 * i, 120, 200)))
    dst.close()
    return dst_buf.getvalue()


def test_in_cell_pictures_land_on_their_rows(tmp_path):
    path = tmp_path / "incell.part"
    path.write_bytes(_in_cell_xlsx({2: 0, 3: 1}))
    progress = []
    rows = si.xlsx_rows_from_path(str(path), on_progress=lambda d, t: progress.append((d, t)))

    by_sku = {r["SKU"]: r for r in rows}
    assert by_sku["DL-1"]["Front Photo"].startswith("data:image/jpeg")
    assert by_sku["J4-1"]["Front Photo"] != by_sku["DL-1"]["Front Photo"]
    assert "Front Photo" not in by_sku["NP-1"]
    # Excel's #VALUE! placeholder for the picture cell is not kept as text.
    assert all(v != "#VALUE!" for r in rows for v in r.values())
    assert progress[-1] == (2, 2)

    # Thumbnails stay small.
    import base64

    thumb = Image.open(io.BytesIO(base64.b64decode(by_sku["DL-1"]["Front Photo"].split(",", 1)[1])))
    assert max(thumb.size) <= si.MAX_EMBEDDED_IMAGE_DIMENSION


def test_same_picture_in_two_cells_is_read_once(tmp_path, monkeypatch):
    calls = []
    real = si._image_data_url
    monkeypatch.setattr(si, "_image_data_url", lambda data, p: calls.append(p) or real(data, p))
    path = tmp_path / "dup.part"
    path.write_bytes(_in_cell_xlsx({2: 0, 3: 0}, images=1))
    rows = si.xlsx_rows_from_path(str(path))
    assert rows[0]["Front Photo"] == rows[1]["Front Photo"] and len(calls) == 1


def test_broken_picture_links_keep_the_rows(tmp_path):
    path = tmp_path / "broken.part"
    path.write_bytes(_in_cell_xlsx({2: 0}, broken_vm=True))
    rows = si.xlsx_rows_from_path(str(path))
    assert len(rows) == 3 and all("Front Photo" not in r for r in rows)


def test_damaged_rich_data_is_ignored():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{MAIN}"/>')
        z.writestr("xl/metadata.xml", "<not-xml")
        z.writestr("xl/richData/rdrichvalue.xml", "<x/>")
    archive = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
    assert si._in_cell_picture_anchors(archive, "xl/worksheets/sheet1.xml") == []
    assert si._xlsx_first_sheet_images(b"not a zip") == []
    assert si._xlsx_first_sheet_images(buf.getvalue()) == []


def test_photo_link_in_the_row_wins_for_the_front_photo():
    rows = [(2, {"Product Name": "Dunk", "Image URL": "https://x.test/a.jpg"})]
    pics = [si.EmbeddedImage(row=2, col=5, data_url="data:image/jpeg;base64,AA"),
            si.EmbeddedImage(row=2, col=4, data_url="data:image/jpeg;base64,BB")]
    si._attach_row_photos(rows, pics)
    assert rows[0][1]["Back Photo"].endswith("BB") and "Front Photo" not in rows[0][1]

    two = [(3, {"Product Name": "Hat"})]
    si._attach_row_photos(two, [si.EmbeddedImage(row=3, col=2, data_url="data:image/png;base64,F"),
                                si.EmbeddedImage(row=3, col=1, data_url="data:image/png;base64,E")])
    assert two[0][1]["Front Photo"].endswith("E") and two[0][1]["Back Photo"].endswith("F")


def test_col_letters():
    assert [si._col_number(c) for c in ("A", "Z", "AA", "AD")] == [1, 26, 27, 30]
