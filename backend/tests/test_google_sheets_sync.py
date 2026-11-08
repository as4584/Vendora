"""Google Sheets sync: OAuth, create/link, pull (sheet wins), push via outbox,
conflicts, rate limits and user scoping. All Google HTTP is mocked."""
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import parse_qs, unquote, urlparse

import httpx
import jwt
import pytest

from app.config import settings
from app.models.google_sheets import GoogleSheetLink, GoogleToken
from app.models.inventory import InventoryItem, InventoryStockLedger
from app.models.provider import ProviderSyncRun, ReconciliationIssue
from app.models.provider_outbox import ProviderOutbox
from app.security.token_encryption import decrypt_token, encrypt_token
from app.services import google_sheets as gs
from app.services.csv_export import INVENTORY_EXPORT_COLUMNS
from app.services.google_sheets import google_sheets_service
from app.services.inventory import deduct_stock
from app.services.outbox import process_outbox

SID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"


def _cell_ref(ref: str) -> tuple[int, int]:
    match = re.fullmatch(r"([A-Z]+)(\d+)", ref)
    col = 0
    for ch in match.group(1):
        col = col * 26 + (ord(ch) - 64)
    return int(match.group(2)) - 1, col - 1


class FakeGoogle:
    """In-memory Google OAuth + Sheets API."""

    def __init__(self):
        self.calls: list[httpx.Request] = []
        self.sheets: dict[str, dict] = {}
        self.queued: list[httpx.Response] = []
        self.forbidden: set[str] = set()
        self.sleeps: list[float] = []

    def grid(self, sid=SID, tab="Inventory") -> list[list]:
        return self.sheets[sid]["tabs"][tab]

    def add_sheet(self, rows, sid=SID, title="Stock", tab="Inventory"):
        self.sheets[sid] = {"title": title, "tabs": {tab: [list(r) for r in rows]}, "gid": 0}

    def _set(self, grid, row, col, value):
        while len(grid) <= row:
            grid.append([])
        line = grid[row]
        while len(line) <= col:
            line.append("")
        line[col] = value

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.queued:
            return self.queued.pop(0)
        url = request.url
        if url.host == "oauth2.googleapis.com" and url.path == "/token":
            form = parse_qs(request.content.decode())
            body = {"access_token": "access-new", "expires_in": 3600, "scope": gs.SCOPES}
            if form.get("grant_type") == ["authorization_code"]:
                body["refresh_token"] = "refresh-1"
                self.last_verifier = form.get("code_verifier", [None])[0]
            return httpx.Response(200, json=body)
        if url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={})
        if url.host == "openidconnect.googleapis.com":
            return httpx.Response(200, json={"email": "seller@example.com"})
        path = unquote(url.path).removeprefix("/v4/spreadsheets")
        if request.method == "POST" and path == "":
            body = httpx.Response(200, content=request.content).json()
            tab = body["sheets"][0]["properties"]["title"]
            self.created_body = body
            self.add_sheet([], sid=SID, title=body["properties"]["title"], tab=tab)
            return httpx.Response(200, json={
                "spreadsheetId": SID, "spreadsheetUrl": f"https://docs.google.com/spreadsheets/d/{SID}/edit",
                "properties": {"title": body["properties"]["title"]},
                "sheets": [{"properties": {"title": tab, "sheetId": 0}}],
            })
        sid, _, rest = path.lstrip("/").partition("/")
        sid = sid.split(":")[0]
        if sid in self.forbidden or sid not in self.sheets:
            return httpx.Response(404, json={"error": {"message": "Requested entity was not found."}})
        sheet = self.sheets[sid]
        if request.method == "GET" and not rest:
            return httpx.Response(200, json={
                "spreadsheetId": sid, "properties": {"title": sheet["title"]},
                "sheets": [{"properties": {"title": t, "sheetId": i}} for i, t in enumerate(sheet["tabs"])],
            })
        if request.method == "GET" and rest.startswith("values/"):
            tab = rest.removeprefix("values/").strip("'")
            rows = [list(r) for r in sheet["tabs"][tab]]
            while rows and not any(str(c) for c in rows[-1]):
                rows.pop()
            return httpx.Response(200, json={"values": [[("" if c is None else str(c)) for c in r] for r in rows]})
        body = httpx.Response(200, content=request.content).json()
        if path.endswith("values:batchUpdate"):
            assert body["valueInputOption"] == "RAW"
            for entry in body["data"]:
                tab, _, ref = entry["range"].rpartition("!")
                grid = sheet["tabs"][tab.strip("'")]
                r0, c0 = _cell_ref(ref)
                for dr, line in enumerate(entry["values"]):
                    for dc, value in enumerate(line):
                        self._set(grid, r0 + dr, c0 + dc, value)
            return httpx.Response(200, json={})
        if path.endswith(":append"):
            assert url.params["valueInputOption"] == "RAW"
            tab = rest.removeprefix("values/").split("!")[0].strip("'")
            grid = sheet["tabs"][tab]
            while grid and not any(str(c) for c in grid[-1]):
                grid.pop()
            grid.extend(list(r) for r in body["values"])
            return httpx.Response(200, json={})
        return httpx.Response(400, json={"error": {"message": f"unhandled {request.method} {path}"}})

    def writes(self):
        return [r for r in self.calls if r.method == "POST" and "values:batchUpdate" in r.url.path]


@pytest.fixture()
def configured(monkeypatch):
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "client-id.apps.googleusercontent.com")
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_SECRET", "secret")
    monkeypatch.setattr(settings, "GOOGLE_REDIRECT_URI", "https://example.test/api/v1/integrations/google/callback")


@pytest.fixture()
def fake(monkeypatch, configured):
    fake = FakeGoogle()
    monkeypatch.setattr(google_sheets_service, "transport", httpx.MockTransport(fake.handler))

    async def no_sleep(seconds):
        fake.sleeps.append(seconds)

    monkeypatch.setattr(google_sheets_service, "sleep", no_sleep)
    return fake


@pytest.fixture()
def token(db, test_user, configured):
    tok = GoogleToken(
        user_id=test_user.id, email="seller@example.com",
        access_token=encrypt_token("access-1"), refresh_token=encrypt_token("refresh-1"),
        expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    db.add(tok)
    db.flush()
    return tok


def _item(db, user, **kw):
    data = {"name": "Jordan 1 Chicago", "sku": "DZ5485-612", "size": "10", "quantity": 3,
            "expected_sell_price": Decimal("250.00"), "buy_price": Decimal("180.00")}
    data.update(kw)
    item = InventoryItem(user_id=user.id, **data)
    db.add(item)
    db.flush()
    return item


def _col(name):
    return INVENTORY_EXPORT_COLUMNS.index(name)


def _row_for(fake, item):
    for row in fake.grid()[1:]:
        if row and str(row[0]) == str(item.id):
            return row
    raise AssertionError("row not found")


# ── OAuth ────────────────────────────────────────────────────────────────────

class TestOAuth:
    def test_not_configured(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "")
        body = client.get("/api/v1/integrations/google/status", headers=auth_headers).json()
        assert body["configured"] is False and body["connected"] is False
        assert client.get("/api/v1/integrations/google/connect", headers=auth_headers).status_code == 503
        assert client.post("/api/v1/integrations/google/sync", headers=auth_headers).status_code == 503

    def test_not_connected_is_409(self, client, auth_headers, configured):
        assert client.post("/api/v1/integrations/google/sync", headers=auth_headers).status_code == 409
        assert client.post("/api/v1/integrations/google/sheet/create", json={}, headers=auth_headers).status_code == 409

    def test_connect_url_uses_pkce_and_drive_file(self, client, auth_headers, configured, test_user):
        url = client.get("/api/v1/integrations/google/connect?platform=web", headers=auth_headers).json()["authorization_url"]
        q = parse_qs(urlparse(url).query)
        assert url.startswith(gs.AUTH_URL)
        assert q["scope"] == ["https://www.googleapis.com/auth/drive.file openid email"]
        assert q["code_challenge_method"] == ["S256"] and len(q["code_challenge"][0]) >= 43
        assert q["access_type"] == ["offline"]
        state = jwt.decode(q["state"][0], settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        assert state["sub"] == str(test_user.id) and state["ret"] == "web"
        assert state["cv"].startswith("enc:")  # verifier never travels in clear

    def test_state_rejects_tampering_and_other_purpose(self, configured):
        bad = jwt.encode({"sub": "x", "purpose": "stockx_oauth"}, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
        for state in ("garbage", bad):
            with pytest.raises(Exception) as exc:
                google_sheets_service.parse_state(state)
            assert exc.value.status_code == 400

    def test_native_callback_stores_encrypted_tokens(self, client, db, test_user, fake):
        url = google_sheets_service.authorization_url(test_user.id, "native")
        state = parse_qs(urlparse(url).query)["state"][0]
        resp = client.get(f"/api/v1/integrations/google/callback?state={state}&code=abc", follow_redirects=False)
        assert resp.status_code == 303
        assert resp.headers["location"] == "vendora://settings?integration=google_sheets&status=connected"
        tok = db.query(GoogleToken).filter_by(user_id=test_user.id).one()
        assert tok.access_token.startswith("enc:") and decrypt_token(tok.refresh_token) == "refresh-1"
        assert tok.email == "seller@example.com"
        assert fake.last_verifier and len(fake.last_verifier) >= 43

    def test_web_callback_posts_message_and_falls_back_to_settings(self, client, test_user, fake):
        url = google_sheets_service.authorization_url(test_user.id, "web")
        state = parse_qs(urlparse(url).query)["state"][0]
        resp = client.get(f"/api/v1/integrations/google/callback?state={state}&code=abc")
        assert resp.status_code == 200
        assert "postMessage" in resp.text and "resqlo-oauth" in resp.text
        assert "settings?integration=google_sheets&status=connected" in resp.text

    def test_denied_and_exchange_failure(self, client, test_user, fake):
        state = parse_qs(urlparse(google_sheets_service.authorization_url(test_user.id)).query)["state"][0]
        resp = client.get(f"/api/v1/integrations/google/callback?state={state}&error=access_denied", follow_redirects=False)
        assert resp.headers["location"].endswith("status=denied")
        fake.queued.append(httpx.Response(400, json={"error": "invalid_grant"}))
        resp = client.get(f"/api/v1/integrations/google/callback?state={state}&code=x", follow_redirects=False)
        assert resp.headers["location"].endswith("status=error")

    async def test_refresh_once_on_401(self, db, test_user, token, fake):
        fake.add_sheet([["id", "name"]])
        fake.queued.append(httpx.Response(401, json={}))
        meta = await google_sheets_service.request(db, test_user.id, "GET", f"{gs.SHEETS_API}/{SID}")
        assert meta["spreadsheetId"] == SID
        assert decrypt_token(token.access_token) == "access-new"

    def test_disconnect_removes_token_and_link(self, client, auth_headers, db, test_user, token, fake):
        db.add(GoogleSheetLink(user_id=test_user.id, spreadsheet_id=SID, sheet_tab="Inventory", header_map={}, row_state={}))
        db.flush()
        assert client.delete("/api/v1/integrations/google", headers=auth_headers).json() == {"disconnected": True}
        assert db.query(GoogleToken).filter_by(user_id=test_user.id).count() == 0
        assert db.query(GoogleSheetLink).filter_by(user_id=test_user.id).count() == 0


# ── create / link ────────────────────────────────────────────────────────────

class TestLinking:
    def test_create_sheet_writes_canonical_header_and_inventory(self, client, auth_headers, db, test_user, token, fake):
        item = _item(db, test_user, name="=HYPERLINK(\"http://evil\")", notes="+cmd")
        resp = client.post("/api/v1/integrations/google/sheet/create", json={}, headers=auth_headers)
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["sheet"]["tab"] == "Inventory" and body["sheet"]["source_of_truth"] is True
        assert fake.created_body["sheets"][0]["properties"]["gridProperties"]["frozenRowCount"] == 1
        grid = fake.grid()
        assert grid[0] == INVENTORY_EXPORT_COLUMNS
        row = _row_for(fake, item)
        assert row[_col("name")] == "'=HYPERLINK(\"http://evil\")"  # formula injection neutralised
        assert row[_col("notes")] == "'+cmd"
        assert row[_col("quantity")] == 3 and row[_col("expected_sell_price")] == 250.0
        assert not any(str(c).startswith("=") for c in row)  # never a formula

    def test_link_existing_maps_aliases_and_adds_id_column(self, client, auth_headers, db, test_user, token, fake):
        fake.add_sheet([["Item Name", "Qty", "Price", "SKU"], ["Dunk Low Panda", "4", "$120.00", "DD1391-100"]])
        resp = client.post("/api/v1/integrations/google/sheet/link",
                           json={"url": f"https://docs.google.com/spreadsheets/d/{SID}/edit#gid=0"}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert set(resp.json()["sheet"]["mapped_columns"]) >= {"id", "name", "quantity", "sku"}
        assert fake.grid()[0][4] == "id"
        item = db.query(InventoryItem).filter_by(user_id=test_user.id, sku="DD1391-100").one()
        assert item.quantity == 4 and item.name == "Dunk Low Panda"
        assert fake.grid()[1][4] == str(item.id)  # id written back

    def test_link_unreachable_sheet_explains_drive_file(self, client, auth_headers, token, fake):
        resp = client.post("/api/v1/integrations/google/sheet/link",
                           json={"url": f"https://docs.google.com/spreadsheets/d/{SID}/edit"}, headers=auth_headers)
        assert resp.status_code == 422
        assert "Create a Resqlo sheet" in resp.json()["detail"]

    def test_link_rejects_non_sheet_url(self, client, auth_headers, token, fake):
        resp = client.post("/api/v1/integrations/google/sheet/link", json={"url": "https://example.com/x"}, headers=auth_headers)
        assert resp.status_code == 422

    def test_settings_toggle_and_unlink(self, client, auth_headers, db, test_user, token, fake):
        client.post("/api/v1/integrations/google/sheet/create", json={}, headers=auth_headers)
        body = client.patch("/api/v1/integrations/google/sheet", json={"source_of_truth": False, "archive_missing": True},
                            headers=auth_headers).json()
        assert body["sheet"]["source_of_truth"] is False and body["sheet"]["archive_missing"] is True
        assert client.delete("/api/v1/integrations/google/sheet", headers=auth_headers).json()["sheet"] is None


# ── pull ─────────────────────────────────────────────────────────────────────

class TestPull:
    async def test_sheet_edit_updates_item_with_ledger(self, db, test_user, token, fake):
        item = _item(db, test_user)
        await google_sheets_service.create_sheet(db, test_user.id)
        _row_for(fake, item)[_col("quantity")] = "7"
        _row_for(fake, item)[_col("expected_sell_price")] = "$275"
        run = await google_sheets_service.pull(db, test_user.id)
        db.refresh(item)
        assert item.quantity == 7 and item.expected_sell_price == Decimal("275.00")
        assert run.items_updated == 1 and run.status == "completed"
        ledger = db.query(InventoryStockLedger).filter_by(inventory_item_id=item.id, event_type="sync").one()
        assert ledger.delta_quantity == 4 and ledger.source_type == "google_sheets"

    async def test_new_row_creates_item_and_writes_id_back(self, db, test_user, token, fake):
        await google_sheets_service.create_sheet(db, test_user.id)
        row = [""] * len(INVENTORY_EXPORT_COLUMNS)
        row[_col("name")], row[_col("quantity")], row[_col("sku")] = "Yeezy 350 Onyx", "2", "HQ4540"
        fake.grid().append(row)
        run = await google_sheets_service.pull(db, test_user.id)
        item = db.query(InventoryItem).filter_by(user_id=test_user.id, sku="HQ4540").one()
        assert run.items_imported == 1 and item.quantity == 2 and item.source == "google_sheets"
        assert fake.grid()[-1][0] == str(item.id)
        # A second pull is a no-op: nothing created twice.
        await google_sheets_service.pull(db, test_user.id)
        assert db.query(InventoryItem).filter_by(user_id=test_user.id, sku="HQ4540").count() == 1

    async def test_removed_row_is_flagged_then_archived_when_enabled(self, db, test_user, token, fake):
        keep, gone = _item(db, test_user, sku="A1"), _item(db, test_user, sku="B2", name="Gone")
        link = await google_sheets_service.create_sheet(db, test_user.id)
        fake.grid().remove(_row_for(fake, gone))
        await google_sheets_service.pull(db, test_user.id)
        db.refresh(gone)
        assert gone.status != "archived"
        issue = db.query(ReconciliationIssue).filter_by(inventory_item_id=gone.id, issue_type="missing_item").one()
        assert issue.provider == "google_sheets"
        link.archive_missing = True
        db.commit()
        run = await google_sheets_service.pull(db, test_user.id)
        db.refresh(gone)
        db.refresh(keep)
        assert gone.status == "archived" and gone.deleted_at is None  # archived, never hard deleted
        assert keep.status != "archived"
        assert run.metadata_["archived"] == 1

    async def test_app_only_items_are_appended(self, db, test_user, token, fake):
        await google_sheets_service.create_sheet(db, test_user.id)
        late = _item(db, test_user, sku="LATE", name="Late Item")
        await google_sheets_service.pull(db, test_user.id)
        assert _row_for(fake, late)[_col("sku")] == "LATE"

    async def test_conflict_sheet_wins_and_is_recorded(self, db, test_user, token, fake):
        item = _item(db, test_user)
        await google_sheets_service.create_sheet(db, test_user.id)
        item.expected_sell_price = Decimal("300.00")  # app edit
        db.commit()
        _row_for(fake, item)[_col("expected_sell_price")] = "260"  # sheet edit
        run = await google_sheets_service.pull(db, test_user.id)
        db.refresh(item)
        assert item.expected_sell_price == Decimal("260.00")
        conflict = run.metadata_["conflicts"][0]
        assert conflict["fields"]["expected_sell_price"] == {"app": "300.00", "sheet": "260.00"}
        assert "expected_sell_price" in run.metadata_["note"]
        issue = db.query(ReconciliationIssue).filter_by(sync_run_id=run.id).one()
        assert issue.details["kind"] == "sheet_wins_conflict"

    async def test_periodic_noop_records_no_run(self, db, test_user, token, fake):
        _item(db, test_user)
        await google_sheets_service.create_sheet(db, test_user.id)
        await google_sheets_service.pull(db, test_user.id, trigger="periodic")
        before = db.query(ProviderSyncRun).filter_by(user_id=test_user.id).count()
        assert await google_sheets_service.pull(db, test_user.id, trigger="periodic") is None
        assert db.query(ProviderSyncRun).filter_by(user_id=test_user.id).count() == before

    async def test_periodic_failure_records_failed_run_once(self, db, test_user, token, fake):
        await google_sheets_service.create_sheet(db, test_user.id)
        fake.forbidden.add(SID)
        await gs.pull_all(db)
        await gs.pull_all(db)
        runs = db.query(ProviderSyncRun).filter_by(user_id=test_user.id, status="failed").all()
        assert len(runs) == 1
        assert google_sheets_service.get_link(db, test_user.id).last_error

    def test_sync_now_endpoint_and_retry(self, client, auth_headers, db, test_user, token, fake):
        item = _item(db, test_user)
        client.post("/api/v1/integrations/google/sheet/create", json={}, headers=auth_headers)
        _row_for(fake, item)[_col("quantity")] = "9"
        body = client.post("/api/v1/integrations/google/sync", headers=auth_headers).json()
        assert body["updated"] == 1 and body["run_id"]
        retry = client.post(f"/api/v1/integrations/sync-runs/{body['run_id']}/retry", headers=auth_headers)
        assert retry.status_code == 200, retry.text
        assert retry.json()["message"] == "Google Sheets sync retried."
        runs = client.get("/api/v1/integrations/sync-runs", headers=auth_headers).json()
        assert any(r["provider"] == "google_sheets" for r in runs)


# ── push ─────────────────────────────────────────────────────────────────────

class TestPush:
    async def test_sale_enqueues_and_updates_only_changed_cells(self, db, test_user, token, fake):
        item = _item(db, test_user)
        await google_sheets_service.create_sheet(db, test_user.id)
        deduct_stock(db, item, 1, "sale", "transaction", "t-1")
        db.commit()
        job = db.query(ProviderOutbox).filter_by(provider="google_sheets", inventory_item_id=item.id).one()
        assert job.action == "push_row" and job.status == "pending"
        writes_before = len(fake.writes())
        assert await process_outbox(db, user_id=test_user.id, provider="google_sheets") == 1
        db.refresh(job)
        assert job.status == "done" and job.payload["outcome"] == "updated:1"
        assert _row_for(fake, item)[_col("quantity")] == 2
        body = httpx.Response(200, content=fake.writes()[writes_before].content).json()
        assert [d["range"] for d in body["data"]] == [f"'Inventory'!{gs.column_letter(_col('quantity'))}2"]

    async def test_push_coalesces_per_item(self, db, test_user, token, fake):
        item = _item(db, test_user)
        await google_sheets_service.create_sheet(db, test_user.id)
        deduct_stock(db, item, 1, "sale", "transaction", "t-1")
        deduct_stock(db, item, 1, "sale", "transaction", "t-2")
        db.commit()
        assert db.query(ProviderOutbox).filter_by(provider="google_sheets", inventory_item_id=item.id).count() == 1

    async def test_push_never_overwrites_sheet_edit(self, db, test_user, token, fake):
        item = _item(db, test_user)
        await google_sheets_service.create_sheet(db, test_user.id)
        _row_for(fake, item)[_col("quantity")] = "10"  # seller edits sheet
        deduct_stock(db, item, 1, "sale", "transaction", "t-1")
        db.commit()
        await process_outbox(db, user_id=test_user.id, provider="google_sheets")
        job = db.query(ProviderOutbox).filter_by(provider="google_sheets").one()
        assert job.payload["outcome"] == "sheet_changed"
        assert _row_for(fake, item)[_col("quantity")] == "10"
        await google_sheets_service.pull(db, test_user.id)
        db.refresh(item)
        assert item.quantity == 10  # sheet wins

    async def test_new_item_via_api_is_appended(self, client, auth_headers, db, test_user, token, fake):
        await google_sheets_service.create_sheet(db, test_user.id)
        resp = client.post("/api/v1/inventory", json={"name": "New Tee", "quantity": 1}, headers=auth_headers)
        assert resp.status_code == 201, resp.text
        await process_outbox(db, user_id=test_user.id, provider="google_sheets")
        assert any(r and r[0] == resp.json()["id"] for r in fake.grid())

    async def test_edit_via_api_pushes_price(self, client, auth_headers, db, test_user, token, fake):
        item = _item(db, test_user)
        await google_sheets_service.create_sheet(db, test_user.id)
        client.put(f"/api/v1/inventory/{item.id}", json={"expected_sell_price": "199.99"}, headers=auth_headers)
        await process_outbox(db, user_id=test_user.id, provider="google_sheets")
        assert _row_for(fake, item)[_col("expected_sell_price")] == 199.99

    async def test_no_link_means_no_job(self, db, test_user, token):
        item = _item(db, test_user)
        deduct_stock(db, item, 1, "sale", "transaction", "t-1")
        assert db.query(ProviderOutbox).filter_by(provider="google_sheets").count() == 0


# ── rate limits ──────────────────────────────────────────────────────────────

class TestRateLimits:
    async def test_429_backs_off_with_retry_after(self, db, test_user, token, fake):
        fake.add_sheet([["id", "name"]])
        fake.queued += [httpx.Response(429, headers={"Retry-After": "3"}), httpx.Response(429)]
        await google_sheets_service.request(db, test_user.id, "GET", f"{gs.SHEETS_API}/{SID}")
        assert fake.sleeps == [3.0, 2.0]

    async def test_429_exhausted_leaves_push_pending_with_backoff(self, db, test_user, token, fake):
        item = _item(db, test_user)
        await google_sheets_service.create_sheet(db, test_user.id)
        deduct_stock(db, item, 1, "sale", "transaction", "t-1")
        db.commit()
        fake.queued += [httpx.Response(429)] * (gs.MAX_429_RETRIES + 1)
        await process_outbox(db, user_id=test_user.id, provider="google_sheets")
        job = db.query(ProviderOutbox).filter_by(provider="google_sheets").one()
        assert job.status == "pending" and job.attempts == 1 and job.last_error
        assert job.next_attempt_at > datetime.now(timezone.utc)


# ── user scoping ─────────────────────────────────────────────────────────────

class TestScoping:
    def test_other_user_sees_nothing(self, client, auth_headers, second_auth_headers, db, test_user, token, fake):
        client.post("/api/v1/integrations/google/sheet/create", json={}, headers=auth_headers)
        other = client.get("/api/v1/integrations/google/status", headers=second_auth_headers).json()
        assert other["connected"] is False and other["sheet"] is None
        assert client.post("/api/v1/integrations/google/sync", headers=second_auth_headers).status_code == 409
        client.delete("/api/v1/integrations/google", headers=second_auth_headers)
        assert client.get("/api/v1/integrations/google/status", headers=auth_headers).json()["sheet"] is not None

    async def test_pull_never_touches_other_users_items(self, db, test_user, second_user, token, fake):
        foreign = _item(db, second_user, sku="SHARED")
        await google_sheets_service.create_sheet(db, test_user.id)
        row = [""] * len(INVENTORY_EXPORT_COLUMNS)
        row[0], row[_col("name")], row[_col("sku")], row[_col("quantity")] = str(foreign.id), "Hijack", "SHARED", "0"
        fake.grid().append(row)
        await google_sheets_service.pull(db, test_user.id)
        db.refresh(foreign)
        assert foreign.name == "Jordan 1 Chicago" and foreign.quantity == 3
        mine = db.query(InventoryItem).filter_by(user_id=test_user.id, sku="SHARED").one()
        assert fake.grid()[-1][0] == str(mine.id)
