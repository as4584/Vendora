"""Where an OAuth callback sends the seller once the provider is done.

Native app: the ``vendora://settings`` deep link (the auth session closes on it).
Web app: the provider page runs in a popup that cannot open ``vendora://``, so
the callback returns a tiny HTML page that tells the opener (postMessage +
localStorage event), closes itself, and otherwise falls back to the hosted
web Settings page.

Which one is used comes from the signed OAuth ``state`` (``ret`` claim), never
from a query parameter on the callback, so a crafted callback URL cannot
switch targets.
"""
from __future__ import annotations

import html
import json
from typing import Optional
from urllib.parse import urlencode

from fastapi import status
from fastapi.responses import HTMLResponse, RedirectResponse
import jwt
from jwt.exceptions import InvalidTokenError as JWTError

from app.config import settings

RETURN_WEB = "web"
RETURN_APP = "app"
MESSAGE_TYPE = "resqlo-oauth"


def return_target_for(platform: Optional[str]) -> str:
    """Map the authenticated connect call's ``platform`` to a state claim."""
    return RETURN_WEB if (platform or "").strip().lower() == RETURN_WEB else RETURN_APP


def state_return_target(state: str) -> str:
    """Read the ``ret`` claim from an already-verified state token."""
    try:
        payload = jwt.decode(state, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return RETURN_APP
    return RETURN_WEB if payload.get("ret") == RETURN_WEB else RETURN_APP


def _web_settings_url(provider: str, result: str) -> str:
    base = settings.WEB_APP_URL.rstrip("/")
    return f"{base}/settings?{urlencode({'integration': provider, 'status': result})}"


def finish_response(provider: str, result: str, state: str, app_url: Optional[str] = None):
    """Build the callback response for ``provider`` ending in ``result``."""
    if state_return_target(state) != RETURN_WEB:
        target = app_url or f"vendora://settings?{urlencode({'integration': provider, 'status': result})}"
        return RedirectResponse(target, status_code=status.HTTP_303_SEE_OTHER)

    fallback = _web_settings_url(provider, result)
    origin = settings.WEB_APP_URL.rstrip("/")
    message = {"type": MESSAGE_TYPE, "provider": provider, "status": result}
    # json.dumps output is safe inside <script> once "</" is escaped.
    msg_js = json.dumps(message).replace("</", "<\\/")
    origin_js = json.dumps(origin).replace("</", "<\\/")
    fallback_js = json.dumps(fallback).replace("</", "<\\/")
    label = "connected" if result == "connected" else "not connected"
    body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Resqlo</title>
<style>body{{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8eaf0;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;text-align:center}}
a{{color:#8ab4ff}}</style></head>
<body><main><p>{html.escape(provider.title())} {label}. You can close this window.</p>
<p><a href="{html.escape(fallback)}">Back to Resqlo settings</a></p></main>
<script>
(function () {{
  var msg = {msg_js};
  try {{ if (window.opener) window.opener.postMessage(msg, {origin_js}); }} catch (e) {{}}
  try {{ localStorage.setItem("resqlo-oauth", JSON.stringify(Object.assign({{at: Date.now()}}, msg))); }} catch (e) {{}}
  if (window.opener) {{ try {{ window.close(); }} catch (e) {{}} }}
  setTimeout(function () {{ window.location.replace({fallback_js}); }}, window.opener ? 800 : 0);
}})();
</script></body></html>"""
    return HTMLResponse(
        body,
        headers={
            "Cache-Control": "no-store",
            "Content-Security-Policy": (
                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
            ),
        },
    )
