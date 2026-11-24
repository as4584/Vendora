"""GET /inventory/labels.pdf — printable price labels with scan-to-sell QR."""
import uuid
from decimal import Decimal

from app.models.inventory import InventoryItem
from app.services.labels import QR_PREFIX, build_labels_pdf, expand, label_for

URL = "/api/v1/inventory/labels.pdf"


def _item(db, user, **kw):
    item = InventoryItem(user_id=user.id, **{"name": "Jordan 4", "quantity": 1, **kw})
    db.add(item)
    db.commit()
    return item


class TestLabelContent:
    def test_label_fields(self):
        item = InventoryItem(id=uuid.uuid4(), name="Air Jordan 4 ‘Black Cat’ — 日本", size="10",
                             condition="New", expected_sell_price=Decimal("1250"), upc=" 195244123456 ", quantity=3)
        label = label_for(item)
        assert label.name == "Air Jordan 4 'Black Cat' -"
        assert label.detail == "Size 10 - New"
        assert label.price == "$1,250.00"
        assert label.qr == f"{QR_PREFIX}{item.id}"
        assert label.code == "195244123456"

    def test_missing_fields_and_sku_fallback(self):
        item = InventoryItem(id=uuid.uuid4(), name="日本", sku="SKU-1", quantity=None)
        label = label_for(item)
        assert (label.name, label.detail, label.price, label.code) == ("Item", "", "", "SKU-1")
        assert label_for(InventoryItem(id=uuid.uuid4(), name="x")).code is None

    def test_per_unit_copies_and_cap(self):
        a = InventoryItem(id=uuid.uuid4(), name="a", quantity=3)
        b = InventoryItem(id=uuid.uuid4(), name="b", quantity=0)
        assert len(expand([a, b], per_unit=True)) == 4
        assert len(expand([a, b], per_unit=False)) == 2
        assert len(expand([InventoryItem(id=uuid.uuid4(), name="c", quantity=999)], per_unit=True)) == 600

    def test_layouts_paginate(self):
        labels = expand([InventoryItem(id=uuid.uuid4(), name=f"i{i}", quantity=1) for i in range(31)], False)
        thermal = build_labels_pdf(labels, "thermal")
        sheet = build_labels_pdf(labels, "sheet")
        assert thermal.startswith(b"%PDF") and thermal.count(b"/Type /Page\n") == 31
        assert sheet.count(b"/Type /Page\n") == 2
        assert build_labels_pdf([], "sheet").startswith(b"%PDF")


class TestLabelsEndpoint:
    def test_returns_pdf_for_owned_items_only(self, client, auth_headers, db, test_user, second_user):
        mine = _item(db, test_user, expected_sell_price=Decimal("250"))
        theirs = _item(db, second_user)
        resp = client.get(URL, params={"ids": f"{mine.id},{theirs.id},{mine.id}", "layout": "sheet"}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/pdf"
        assert resp.content.startswith(b"%PDF")
        assert client.get(URL, params={"ids": str(theirs.id)}, headers=auth_headers).status_code == 404

    def test_per_unit_thermal(self, client, auth_headers, db, test_user):
        item = _item(db, test_user, quantity=3)
        resp = client.get(URL, params={"ids": str(item.id), "per_unit": "true"}, headers=auth_headers)
        assert resp.content.count(b"/Type /Page\n") == 3

    def test_validates_ids_and_layout(self, client, auth_headers):
        assert client.get(URL, params={"ids": "nope"}, headers=auth_headers).status_code == 422
        assert client.get(URL, params={"ids": " , "}, headers=auth_headers).status_code == 422
        many = ",".join(str(uuid.uuid4()) for _ in range(201))
        assert client.get(URL, params={"ids": many}, headers=auth_headers).status_code == 422
        assert client.get(URL, params={"ids": str(uuid.uuid4()), "layout": "a4"}, headers=auth_headers).status_code == 422
        assert client.get(URL, params={"ids": str(uuid.uuid4())}).status_code == 401
