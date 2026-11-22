"""POST/GET /trades — swap pairs plus cash in one atomic write."""
from decimal import Decimal

from app.models.inventory import InventoryItem, InventoryStockLedger
from app.models.transaction import OrderPayment, Trade, Transaction

API = "/api/v1/trades"
D = Decimal


def _item(db, user, name="Jordan 4", qty=1, cost="150.00", price="250.00", **kw):
    item = InventoryItem(user_id=user.id, name=name, quantity=qty, buy_price=D(cost) if cost else None,
                         expected_sell_price=D(price), **kw)
    db.add(item)
    db.commit()
    return item


def _trade(client, headers, **body):
    return client.post(API, json=body, headers=headers)


class TestTrades:
    def test_pair_for_pair_plus_cash_received(self, client, auth_headers, db, test_user):
        """My 4s ($250) for their 11s ($220) + $30 cash."""
        mine = _item(db, test_user)
        resp = _trade(client, auth_headers, give=[{"item_id": str(mine.id), "value": "250.00"}],
                      get=[{"name": "Jordan 11 Concord", "size": "10", "value": "220.00"}],
                      cash_amount="30.00", cash_method="venmo")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert D(body["value_out"]) == D("250.00")
        assert D(body["value_in"]) == D("220.00")
        assert D(body["profit"]) == D("100.00")  # 250 value - 150 cost

        db.expire_all()
        assert db.get(InventoryItem, mine.id).quantity == 0
        assert db.get(InventoryItem, mine.id).status == "sold"
        txn = db.query(Transaction).filter(Transaction.item_id == mine.id).one()
        assert (txn.method, txn.gross_amount, txn.fee_amount, txn.cost_amount) == ("trade", D("250.00"), D("0.00"), D("150.00"))
        new = db.get(InventoryItem, body["received_item_ids"][0])
        assert (new.name, new.size, new.buy_price, new.expected_sell_price, new.source) == (
            "Jordan 11 Concord", "10", D("220.00"), D("220.00"), "trade")
        pay = db.query(OrderPayment).filter(OrderPayment.order_id == txn.order_id).one()
        assert (pay.method, pay.amount) == ("venmo", D("30.00"))
        ledger = db.query(InventoryStockLedger).filter(InventoryStockLedger.inventory_item_id == mine.id).one()
        assert (ledger.event_type, ledger.source_type) == ("sale", "trade")

    def test_i_pay_cash_on_top_raises_incoming_basis(self, client, auth_headers, db, test_user):
        mine = _item(db, test_user, cost="100.00")
        resp = _trade(client, auth_headers, give=[{"item_id": str(mine.id), "value": "200.00"}],
                      get=[{"name": "Travis Scott 1", "value": "240.00", "list_price": "300.00"}],
                      cash_amount="-40.00")
        assert resp.status_code == 201, resp.text
        new = db.get(InventoryItem, resp.json()["received_item_ids"][0])
        assert new.buy_price == D("240.00")
        assert new.expected_sell_price == D("300.00")
        assert db.query(OrderPayment).count() == 0  # cash went out, not in

    def test_two_for_one_splits_basis_by_value(self, client, auth_headers, db, test_user):
        mine = _item(db, test_user)
        resp = _trade(client, auth_headers, give=[{"item_id": str(mine.id), "value": "300.00"}],
                      get=[{"name": "A", "value": "200.00"}, {"name": "B", "value": "100.00"}])
        ids = resp.json()["received_item_ids"]
        assert [db.get(InventoryItem, i).buy_price for i in ids] == [D("200.00"), D("100.00")]

    def test_agreed_values_differ_from_basis_split_proportionally(self, client, auth_headers, db, test_user):
        """Gave $250 + took $50 = paid $200 for pairs 'worth' $150 + $150."""
        mine = _item(db, test_user)
        resp = _trade(client, auth_headers, give=[{"item_id": str(mine.id), "value": "250.00"}],
                      get=[{"name": "A", "value": "150.00"}, {"name": "B", "value": "150.00"}], cash_amount="50.00")
        ids = resp.json()["received_item_ids"]
        assert sum(db.get(InventoryItem, i).buy_price for i in ids) == D("200.00")

    def test_zero_values_split_evenly(self, client, auth_headers, db, test_user):
        resp = _trade(client, auth_headers, get=[{"name": "A", "value": "0"}, {"name": "B", "value": "0"}],
                      cash_amount="-90.00")
        assert resp.status_code == 201, resp.text
        assert sorted(db.get(InventoryItem, i).buy_price for i in resp.json()["received_item_ids"]) == [D("45.00"), D("45.00")]

    def test_cash_only_buy(self, client, auth_headers, db, test_user):
        resp = _trade(client, auth_headers, get=[{"name": "Dunk Panda", "value": "90.00"}], cash_amount="-70.00")
        assert resp.status_code == 201
        body = resp.json()
        assert body["transaction_ids"] == [] and body["profit"] == "0.00"
        assert db.get(InventoryItem, body["received_item_ids"][0]).buy_price == D("70.00")

    def test_rejects_unbalanced(self, client, auth_headers, db, test_user):
        mine = _item(db, test_user)
        assert _trade(client, auth_headers, give=[{"item_id": str(mine.id), "value": "100.00"}],
                      get=[{"name": "A", "value": "50.00"}], cash_amount="150.00").status_code == 422
        assert _trade(client, auth_headers, give=[{"item_id": str(mine.id), "value": "100.00"}],
                      cash_amount="90.00").status_code == 422
        assert _trade(client, auth_headers).status_code == 422
        db.expire_all()
        assert db.get(InventoryItem, mine.id).quantity == 1
        assert db.query(Trade).count() == 0

    def test_give_only_with_matching_cash_is_a_sale(self, client, auth_headers, db, test_user):
        mine = _item(db, test_user)
        resp = _trade(client, auth_headers, give=[{"item_id": str(mine.id), "value": "100.00"}], cash_amount="100.00")
        assert resp.status_code == 201
        assert resp.json()["received_item_ids"] == []

    def test_out_of_stock_and_foreign_items_rolled_back(self, client, auth_headers, second_auth_headers, db, test_user):
        mine = _item(db, test_user, qty=1)
        resp = _trade(client, auth_headers, give=[{"item_id": str(mine.id), "quantity": 2, "value": "10.00"}],
                      get=[{"name": "A", "value": "20.00"}])
        assert resp.status_code == 409
        assert _trade(client, second_auth_headers, give=[{"item_id": str(mine.id), "value": "10.00"}],
                      get=[{"name": "A", "value": "10.00"}]).status_code == 404
        assert db.query(InventoryItem).filter(InventoryItem.name == "A").count() == 0

    def test_unknown_cost_gives_no_profit(self, client, auth_headers, db, test_user):
        mine = _item(db, test_user, cost=None)
        resp = _trade(client, auth_headers, give=[{"item_id": str(mine.id), "value": "100.00"}],
                      get=[{"name": "A", "value": "100.00"}])
        assert resp.json()["profit"] is None

    def test_replay_returns_same_trade(self, client, auth_headers, db, test_user):
        mine = _item(db, test_user, qty=2)
        body = dict(give=[{"item_id": str(mine.id), "value": "100.00"}], get=[{"name": "A", "value": "100.00"}],
                    client_request_id="trade-req-0001")
        first = _trade(client, auth_headers, **body).json()
        second = _trade(client, auth_headers, **body).json()
        assert first["id"] == second["id"]
        db.expire_all()
        assert db.get(InventoryItem, mine.id).quantity == 1

    def test_variant_size_and_customer(self, client, auth_headers, db, test_user):
        from app.models.customer import Customer
        cust = Customer(user_id=test_user.id, name="Kid at table 4")
        db.add(cust)
        mine = _item(db, test_user, qty=2, custom_attributes={"variants": [{"size": "9", "quantity": 1}, {"size": "10", "quantity": 1}]})
        resp = _trade(client, auth_headers, give=[{"item_id": str(mine.id), "size": "10", "value": "120.00"}],
                      get=[{"name": "A", "value": "120.00"}], customer_id=str(cust.id))
        assert resp.status_code == 201, resp.text
        txn = db.query(Transaction).filter(Transaction.item_id == mine.id).one()
        assert txn.variant_size == "10" and txn.customer_id == cust.id
        assert db.get(InventoryItem, resp.json()["received_item_ids"][0]).vendor_name == "Kid at table 4"

    def test_list_is_scoped_to_user(self, client, auth_headers, second_auth_headers, db, test_user):
        _trade(client, auth_headers, get=[{"name": "A", "value": "10.00"}], cash_amount="-10.00")
        mine = client.get(API, headers=auth_headers).json()
        assert len(mine) == 1 and D(mine[0]["cash_amount"]) == D("-10.00")
        assert client.get(API, headers=second_auth_headers).json() == []

    def test_trade_lines_cannot_be_refunded(self, client, auth_headers, db, test_user):
        mine = _item(db, test_user)
        txn_id = _trade(client, auth_headers, give=[{"item_id": str(mine.id), "value": "100.00"}],
                        get=[{"name": "A", "value": "100.00"}]).json()["transaction_ids"][0]
        resp = client.post(f"/api/v1/transactions/{txn_id}/refund", json={}, headers=auth_headers)
        assert resp.status_code == 409
        assert resp.json()["detail"]["error"] == "trade_refund_unsupported"
