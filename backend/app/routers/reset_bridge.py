"""HTTPS bridge from the password-reset email into the mobile app.

Gmail and other mail clients often refuse to open custom ``vendora://``
links, so the reset email links here first and this page hands the token to
the app's reset-password screen.

The page is fully static: the token is never interpolated into the HTML or
the script. The script reads it in the browser from the URL fragment
(``#token=...``, used by new emails; never sent to the server) or the query
string (``?token=...``, links sent before the fragment change), checks its
shape, strips it from the address bar, and opens
``vendora://reset-password?token=...``. Expired or already-used tokens are
rejected by ``POST /api/v1/auth/reset-password``, and the app then offers to
request a new link.
"""
import base64
import hashlib

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

TOKEN_PATTERN = r"^[A-Za-z0-9_-]{32,512}$"

_STYLE = (
    "body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;"
    "max-width:34rem;margin:15vh auto;padding:1.5rem;color:#17172a}"
    "a.btn{display:inline-block;padding:.8rem 1rem;border-radius:.6rem;"
    "background:#5b45ff;color:#fff;text-decoration:none;font-size:1rem}"
    "p{line-height:1.5;color:#4a4a5a}[hidden]{display:none}"
)

_SCRIPT = (
    "(function(){"
    "var frag=new URLSearchParams(window.location.hash.slice(1));"
    "var query=new URLSearchParams(window.location.search);"
    "var token=frag.get('token')||query.get('token')||'';"
    "if(window.history&&window.history.replaceState){"
    "window.history.replaceState(null,'',window.location.pathname);}"
    f"if(!/{TOKEN_PATTERN}/.test(token)){{"
    "document.getElementById('valid').hidden=true;"
    "document.getElementById('invalid').hidden=false;return;}"
    "var appUrl='vendora://reset-password?token='+encodeURIComponent(token);"
    "document.getElementById('open-app').setAttribute('href',appUrl);"
    "window.setTimeout(function(){window.location.href=appUrl;},150);"
    "})();"
)


def _csp_hash(source: str) -> str:
    digest = hashlib.sha256(source.encode("utf-8")).digest()
    return "'sha256-" + base64.b64encode(digest).decode("ascii") + "'"


CONTENT_SECURITY_POLICY = (
    "default-src 'none'; "
    f"script-src {_csp_hash(_SCRIPT)}; "
    f"style-src {_csp_hash(_STYLE)}; "
    "img-src 'none'; connect-src 'none'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
}

PAGE = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Reset your Vendora password</title>
<style>{_STYLE}</style>
</head><body>
<section id="valid">
<h1>Reset your Vendora password</h1>
<p>Tap the button below to open Vendora and choose a new password.</p>
<p><a class="btn" id="open-app" href="#">Open Vendora</a></p>
<p>If the app does not open, make sure Vendora is installed from TestFlight, then tap the button again.</p>
</section>
<section id="invalid" hidden>
<h1>This reset link is not valid</h1>
<p>The link is incomplete or damaged. Open Vendora, tap <strong>Forgot password?</strong> on the sign-in screen, and request a new email.</p>
</section>
<noscript><p>Turn on JavaScript to open Vendora from this page, or request a new reset email from the Vendora app.</p></noscript>
<script>{_SCRIPT}</script>
</body></html>"""


@router.get("/reset-password", response_class=HTMLResponse, include_in_schema=False)
def reset_password_bridge() -> HTMLResponse:
    """Serve the static bridge page; the token never touches the server-side HTML."""
    return HTMLResponse(PAGE, headers=SECURITY_HEADERS)
