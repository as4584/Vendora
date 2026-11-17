"""Google Picker: let a seller choose their own existing spreadsheet.

Resqlo only holds the narrow ``drive.file`` permission, so Google lets it open
just the sheets it created or that the seller explicitly picked with Resqlo.
The Picker is Google's own file chooser; choosing a file there grants
``drive.file`` access to that one file, which makes it linkable.

Flow (works the same from the app and the web):
  1. Authenticated ``GET /integrations/google/picker`` returns a one-off page
     URL carrying a short-lived signed ticket (no app session in the URL).
  2. The page (served by the backend, opened in the in-app browser) shows the
     Picker using the seller's current Google access token.
  3. On pick, the page posts the file id with the ticket; the server links the
     sheet and pulls it, then the page returns to the app (deep link) or
     closes the popup (web).
"""
from __future__ import annotations

import html
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException, status
from jwt.exceptions import InvalidTokenError as JWTError
from sqlalchemy.orm import Session

from app.config import settings
from app.services.google_sheets import NATIVE_RETURN, google_sheets_service
from app.services.oauth_return import MESSAGE_TYPE, RETURN_APP, RETURN_WEB
from app.security.token_encryption import decrypt_token

TICKET_PURPOSE = "google_picker"
TICKET_MINUTES = 10
NOT_CONFIGURED = "Picking an existing sheet isn't set up on this server yet."


def picker_configured() -> bool:
    return bool(google_sheets_service.is_configured() and settings.GOOGLE_PICKER_API_KEY)


def public_url(path: str) -> str:
    """Public https URL under /integrations/google/ (the callback URL is already public)."""
    base = settings.GOOGLE_REDIRECT_URI.rsplit("/callback", 1)[0].rstrip("/")
    return f"{base}/{path}"


def project_number() -> str:
    """The Cloud project number is the leading digits of the OAuth client id."""
    return (settings.GOOGLE_CLIENT_ID or "").split("-", 1)[0]


def make_ticket(user_id: uuid.UUID, platform: str) -> str:
    payload = {
        "sub": str(user_id),
        "purpose": TICKET_PURPOSE,
        "ret": RETURN_WEB if platform == RETURN_WEB else RETURN_APP,
        "nonce": secrets.token_urlsafe(12),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=TICKET_MINUTES),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def read_ticket(ticket: str) -> dict:
    try:
        payload = jwt.decode(ticket, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        if payload.get("purpose") != TICKET_PURPOSE:
            raise ValueError("wrong purpose")
        return {"user_id": uuid.UUID(payload["sub"]), "ret": payload.get("ret", RETURN_APP)}
    except (JWTError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="This link expired. Open the picker again from Resqlo.") from exc


async def access_token_for(db: Session, user_id: uuid.UUID) -> str:
    """A Google access token good for at least the next few minutes."""
    token = google_sheets_service.require_token(db, user_id)
    expires = token.expires_at if token.expires_at.tzinfo else token.expires_at.replace(tzinfo=timezone.utc)
    if expires - datetime.now(timezone.utc) < timedelta(minutes=5):
        token = await google_sheets_service.refresh(db, token)
        db.commit()
    return decrypt_token(token.access_token)


def return_url(ret: str, result: str) -> str:
    if ret == RETURN_WEB:
        return f"{settings.WEB_APP_URL.rstrip('/')}/settings?integration=google_sheets&status={result}"
    return NATIVE_RETURN.format(status=result)


def picker_page(ticket: str, access_token: str, ret: str, link_url: str) -> str:
    """The Picker page. Values are JSON-encoded (and '</' escaped) before they enter the script."""
    cfg = {
        "ticket": ticket,
        "token": access_token,
        "key": settings.GOOGLE_PICKER_API_KEY,
        "appId": project_number(),
        "linkUrl": link_url,
        "web": ret == RETURN_WEB,
        "origin": settings.WEB_APP_URL.rstrip("/"),
        "messageType": MESSAGE_TYPE,
        "done": {r: return_url(ret, r) for r in ("linked", "cancelled", "error")},
    }
    data = json.dumps(cfg).replace("</", "<\\/")
    title = html.escape("Pick your sheet · Resqlo")
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>{title}</title>
<style>
 :root {{ color-scheme: light dark; }}
 body {{ margin:0; font: 16px/1.4 -apple-system, system-ui, sans-serif; background:#0e0e11; color:#ededf2;
        display:flex; min-height:100vh; align-items:center; justify-content:center; text-align:center; padding:24px; }}
 @media (prefers-color-scheme: light) {{ body {{ background:#f4f4f7; color:#141418; }} }}
 .box {{ max-width:420px; }} h1 {{ font-size:22px; margin:0 0 8px; }} p {{ opacity:.8; margin:0 0 20px; }}
 button {{ font:inherit; font-weight:600; border:0; border-radius:12px; padding:14px 20px; background:#6a49f0; color:#fff; min-width:220px; }}
</style></head>
<body><div class="box">
 <h1 id="title">Choose your spreadsheet</h1>
 <p id="msg">Google will show your sheets. Pick the one you track inventory in.</p>
 <button id="again" hidden>Open Google Sheets picker</button>
</div>
<script>
const C = {data};
const $ = (id) => document.getElementById(id);
function finish(result) {{
  if (C.web && window.opener) {{
    try {{ window.opener.postMessage({{ type: C.messageType, provider: "google_sheets", status: result }}, C.origin); }} catch (e) {{}}
    window.close();
  }}
  window.location.replace(C.done[result]);
}}
async function picked(doc) {{
  $("title").textContent = "Linking your sheet…";
  $("msg").textContent = doc.name ? doc.name : "";
  try {{
    const r = await fetch(C.linkUrl, {{ method: "POST", headers: {{ "Content-Type": "application/json" }},
      body: JSON.stringify({{ ticket: C.ticket, spreadsheet_id: doc.id }}) }});
    finish(r.ok ? "linked" : "error");
  }} catch (e) {{ finish("error"); }}
}}
function show() {{
  const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setMode(google.picker.DocsViewMode.LIST);
  new google.picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(C.token)
    .setDeveloperKey(C.key)
    .setAppId(C.appId)
    .setTitle("Pick your inventory sheet")
    .setCallback((d) => {{
      if (d.action === google.picker.Action.PICKED && d.docs && d.docs[0]) picked(d.docs[0]);
      else if (d.action === google.picker.Action.CANCEL) finish("cancelled");
    }})
    .build().setVisible(true);
}}
$("again").onclick = show;
window.onPickerApi = () => gapi.load("picker", {{ callback: () => {{ $("again").hidden = false; show(); }} }});
</script>
<script src="https://apis.google.com/js/api.js?onload=onPickerApi" async defer></script>
</body></html>"""


async def link_picked(db: Session, user_id: uuid.UUID, spreadsheet_id: str) -> None:
    url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit"
    await google_sheets_service.link_existing(db, user_id, url, None)
    await google_sheets_service.pull(db, user_id, trigger="manual")


def ensure_configured() -> None:
    if not picker_configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=NOT_CONFIGURED)

