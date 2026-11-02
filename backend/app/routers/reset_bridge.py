"""HTTPS password-reset page with an optional handoff into the mobile app.

Gmail and other mail clients often refuse to open custom ``vendora://``
links, so the reset email links here first. Users may reset in their browser
or open the app's reset-password screen.

The page is fully static: the token is never interpolated into the HTML or
the script. The script reads it in the browser from the URL fragment
(``#token=...``, used by new emails; never sent to the server) or the query
string (``?token=...``, links sent before the fragment change), checks its
shape and strips it from the address bar. It submits the token directly to the
same-origin API or passes it to ``vendora://reset-password?token=...``.
Expired or already-used tokens are
rejected by ``POST /api/v1/auth/reset-password``, and the app then offers to
request a new link.
"""
import base64
import hashlib

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse

from app.config import settings

router = APIRouter()

TOKEN_PATTERN = r"^[A-Za-z0-9_-]{32,512}$"

_STYLE = (
    "body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;"
    "max-width:34rem;margin:15vh auto;padding:1.5rem;color:#17172a}"
    "a.btn,button{display:inline-block;padding:.8rem 1rem;border:0;border-radius:.6rem;"
    "background:#5b45ff;color:#fff;text-decoration:none;font-size:1rem}"
    "label{display:block;margin-top:1rem}input{box-sizing:border-box;width:100%;padding:.7rem;font-size:1rem}"
    "p{line-height:1.5;color:#4a4a5a}[hidden]{display:none!important}"
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
    "var form=document.getElementById('reset-form');"
    "form.addEventListener('submit',async function(e){e.preventDefault();"
    "var password=document.getElementById('password').value;"
    "var confirm=document.getElementById('confirm').value;"
    "var message=document.getElementById('message');"
    "if(password.length<8||new TextEncoder().encode(password).length>72){message.textContent='Use at least 8 characters and no more than 72 UTF-8 bytes.';return;}"
    "if(password!==confirm){message.textContent='Passwords do not match.';return;}"
    "var button=document.getElementById('submit-reset');button.disabled=true;message.textContent='Resetting password…';"
    "var ctrl=window.AbortController?new AbortController():null;var timer=setTimeout(function(){if(ctrl)ctrl.abort();},20000);"
    "try{var response=await fetch('/api/v1/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,password:password}),signal:ctrl?ctrl.signal:undefined});"
    "clearTimeout(timer);"
    "if(!response.ok){message.textContent=response.status===400?'This link is invalid or expired. Request a new one in Vendora.':'Could not reset your password. Please try again.';button.disabled=false;return;}"
    "token='';form.reset();form.hidden=true;var open=document.getElementById('open-app');open.hidden=true;open.setAttribute('href','#');message.textContent='Your password has been reset. Open Vendora and sign in with your new password.';"
    "}catch(err){clearTimeout(timer);message.textContent=(err&&err.name==='AbortError')?'Vendora took too long to respond. Please try again.':'Could not reach Vendora. Check your connection and try again.';button.disabled=false;}"
    "});"
    "})();"
)


def _csp_hash(source: str) -> str:
    digest = hashlib.sha256(source.encode("utf-8")).digest()
    return "'sha256-" + base64.b64encode(digest).decode("ascii") + "'"


CONTENT_SECURITY_POLICY = (
    "default-src 'none'; "
    f"script-src {_csp_hash(_SCRIPT)}; "
    f"style-src {_csp_hash(_STYLE)}; "
    "img-src 'none'; connect-src 'self'; "
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
<p>Choose a new password here, or open Vendora to reset it in the app.</p>
<form id="reset-form">
<label for="password">New password</label><input id="password" type="password" autocomplete="new-password" required>
<label for="confirm">Confirm password</label><input id="confirm" type="password" autocomplete="new-password" required>
<p><button id="submit-reset" type="submit">Reset password</button></p>
</form>
<p id="message" role="status" aria-live="polite"></p>
<p><a class="btn" id="open-app" href="#">Open Vendora</a></p>
</section>
<section id="invalid" hidden>
<h1>This reset link is not valid</h1>
<p>The link is incomplete or damaged. Open Vendora, tap <strong>Forgot password?</strong> on the sign-in screen, and request a new email.</p>
</section>
<noscript><p>Turn on JavaScript to reset your password from this page, or request a new reset email from the Vendora app.</p></noscript>
<script>{_SCRIPT}</script>
</body></html>"""


@router.get("/.well-known/apple-app-site-association", include_in_schema=False)
def apple_app_site_association() -> JSONResponse:
    """Let iOS open /reset-password links directly in the app (Universal Links).

    Without APPLE_TEAM_ID this 404s, and links keep landing on the web page.
    """
    if not settings.APPLE_TEAM_ID:
        raise HTTPException(status_code=404, detail="Not Found")
    app_id = f"{settings.APPLE_TEAM_ID}.{settings.IOS_BUNDLE_ID}"
    return JSONResponse(
        {"applinks": {"details": [{"appIDs": [app_id], "components": [{"/": "/reset-password"}]}]}},
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/reset-password", response_class=HTMLResponse, include_in_schema=False)
def reset_password_bridge() -> HTMLResponse:
    """Serve the static bridge page; the token never touches the server-side HTML."""
    return HTMLResponse(PAGE, headers=SECURITY_HEADERS)
