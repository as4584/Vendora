"""Google Picker: pick one of your own existing sheets and link it."""
from urllib.parse import parse_qs, urlparse

import pytest

from app.config import settings
from app.models.inventory import InventoryItem
from app.services import google_picker
from tests.test_google_sheets_sync import SID, configured, fake, token  # noqa: F401  (fixtures)

BASE = "/api/v1/integrations/google"


@pytest.fixture()
def picker_key(monkeypatch, configured):  # noqa: F811
    monkeypatch.setattr(settings, "GOOGLE_PICKER_API_KEY", "picker-key")


def _ticket(client, auth_headers, platform="native"):
    r = client.get(f"{BASE}/picker?platform={platform}", headers=auth_headers)
    assert r.status_code == 200, r.text
    url = r.json()["picker_url"]
    assert url.startswith("https://example.test/api/v1/integrations/google/picker/page?ticket=")
    return parse_qs(urlparse(url).query)["ticket"][0]


def test_status_reports_picker_only_with_a_key(client, auth_headers, token, monkeypatch):  # noqa: F811
    assert client.get(f"{BASE}/status", headers=auth_headers).json()["picker_available"] is False
    monkeypatch.setattr(settings, "GOOGLE_PICKER_API_KEY", "picker-key")
    assert client.get(f"{BASE}/status", headers=auth_headers).json()["picker_available"] is True


def test_picker_needs_the_key_and_a_connected_account(client, auth_headers, configured):  # noqa: F811
    assert client.get(f"{BASE}/picker", headers=auth_headers).status_code == 503
    settings.GOOGLE_PICKER_API_KEY = "picker-key"
    try:
        assert client.get(f"{BASE}/picker", headers=auth_headers).status_code == 409  # not connected
    finally:
        settings.GOOGLE_PICKER_API_KEY = ""


def test_page_shows_google_picker_with_safe_config(client, auth_headers, token, picker_key, fake):  # noqa: F811
    ticket = _ticket(client, auth_headers)
    r = client.get(f"{BASE}/picker/page?ticket={ticket}")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    body = r.text
    assert "google.picker.PickerBuilder" in body and '"key": "picker-key"' in body
    assert '"appId": "client"' in body  # project number = client id prefix
    assert "vendora://settings?integration=google_sheets\\u0026status=linked" in body
    assert "</script><script>" not in body.split("const C =")[1].split(";\n")[0]


def test_picking_a_sheet_links_and_imports_it(client, auth_headers, db, test_user, token, picker_key, fake):  # noqa: F811
    fake.add_sheet([["Item Name", "Qty", "SKU"], ["Dunk Low Panda", "4", "DD1391-100"]])
    ticket = _ticket(client, auth_headers)
    r = client.post(f"{BASE}/picker/link", json={"ticket": ticket, "spreadsheet_id": SID})
    assert r.status_code == 200, r.text
    status = client.get(f"{BASE}/status", headers=auth_headers).json()
    assert status["sheet"]["spreadsheet_id"] == SID
    assert db.query(InventoryItem).filter_by(user_id=test_user.id, sku="DD1391-100").one().quantity == 4


def test_bad_or_wrong_tickets_are_refused(client, auth_headers, token, picker_key, fake):  # noqa: F811
    assert client.get(f"{BASE}/picker/page?ticket=nope").status_code == 401
    # An OAuth state token is signed with the same key but is not a picker ticket.
    from app.services.google_sheets import google_sheets_service
    state = google_sheets_service.build_state(token.user_id, "app", "verifier")
    r = client.post(f"{BASE}/picker/link", json={"ticket": state, "spreadsheet_id": SID})
    assert r.status_code == 401
    r = client.post(f"{BASE}/picker/link", json={"ticket": _ticket(client, auth_headers), "spreadsheet_id": "bad id/../x"})
    assert r.status_code == 422


def test_web_return_goes_to_hosted_settings(client, auth_headers, token, picker_key, fake):  # noqa: F811
    ticket = _ticket(client, auth_headers, platform="web")
    body = client.get(f"{BASE}/picker/page?ticket={ticket}").text
    assert '"web": true' in body and "/settings?integration=google_sheets\\u0026status=linked" in body
    assert google_picker.read_ticket(ticket)["ret"] == "web"


def test_picker_page_rejects_malformed_ticket(client):
    from app.config import settings
    old = (settings.GOOGLE_CLIENT_ID, settings.GOOGLE_CLIENT_SECRET, settings.GOOGLE_PICKER_API_KEY)
    settings.GOOGLE_CLIENT_ID, settings.GOOGLE_CLIENT_SECRET, settings.GOOGLE_PICKER_API_KEY = "1-x.apps.googleusercontent.com", "s", "k"
    try:
        r = client.get("/api/v1/integrations/google/picker/page", params={"ticket": "</script><script>alert(1)</script>"})
        assert r.status_code == 401
        assert "<script>alert" not in r.text
    finally:
        settings.GOOGLE_CLIENT_ID, settings.GOOGLE_CLIENT_SECRET, settings.GOOGLE_PICKER_API_KEY = old


def test_picker_page_config_has_no_raw_tag_characters():
    from app.services import google_picker
    page = google_picker.picker_page("a.b.c", "tok</script><b>&", "app", "https://x/link")
    script = page.split("const C = ", 1)[1].split(";\n", 1)[0]
    assert "<" not in script and ">" not in script and "&" not in script
