"""Public privacy policy and support pages (required by the App Store listing).

Served at https://vendora.lexmakesit.com/privacy and /support. Static HTML,
no scripts, strict CSP.
"""
from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.config import settings

router = APIRouter()

UPDATED = "November 2, 2026"

_STYLE = (
    "body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:44rem;"
    "margin:3rem auto;padding:0 1.25rem;color:#17172a;line-height:1.6}"
    "h1{margin-bottom:.25rem}h2{margin-top:2rem;font-size:1.15rem}small{color:#6a6a7a}"
    "a{color:#5b45ff}"
)

HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "public, max-age=3600",
}


def _page(title: str, body: str) -> str:
    return (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{title} · Vendora</title><style>{_STYLE}</style></head><body>{body}</body></html>"
    )


def _privacy() -> str:
    email = settings.SUPPORT_EMAIL
    return _page("Privacy Policy", f"""
<h1>Vendora Privacy Policy</h1><small>Last updated {UPDATED}</small>
<p>Vendora is an inventory, sales and invoicing app for independent sellers, operated by LexMakesIt
("we", "us"). This policy explains what we collect, why, and the choices you have.</p>

<h2>What we collect</h2>
<ul>
<li><strong>Account information:</strong> your email address, password (stored only as a secure hash) and optional business name.</li>
<li><strong>Business content you enter:</strong> inventory items, photos you attach, prices, stock levels, sales, invoices
and the customer names or emails you put on invoices.</li>
<li><strong>Connected services:</strong> if you connect Square, Lightspeed, Clover, eBay or StockX, we store the access tokens
those services issue (encrypted) and the inventory/sales data we sync from them.</li>
<li><strong>Support messages</strong> you send from the app.</li>
<li><strong>Purchases:</strong> subscriptions are processed by Apple (in the iOS app) or Stripe (on the web). We receive your
plan, status and renewal date, never your full card details.</li>
</ul>
<p>We do not use advertising trackers, sell your data, or share it with data brokers. Vendora does not track you across
other companies' apps or websites.</p>

<h2>How we use it</h2>
<p>Only to run Vendora: sign you in, store and sync your inventory and sales, generate invoices, provide support,
send account emails (such as password resets), and unlock the plan you paid for.</p>

<h2>Service providers</h2>
<p>We rely on a small number of processors to operate the service: Apple and RevenueCat (in-app subscriptions),
Stripe (web payments and invoice payments), Resend (transactional email), Cloudflare (network delivery), and the
marketplaces or point-of-sale systems you choose to connect. Each receives only what it needs.</p>

<h2>Retention and deletion</h2>
<p>Your data is kept while your account is active. You can delete your account at any time in
<strong>Settings &rarr; Delete Account</strong>; this permanently removes your account and business data from our
servers. Apple subscriptions must also be cancelled in your App Store account settings.</p>

<h2>Security</h2>
<p>Data is sent over HTTPS, passwords are hashed, and third-party tokens are encrypted at rest.</p>

<h2>Children</h2>
<p>Vendora is a business tool and is not directed at children under 13.</p>

<h2>Your rights</h2>
<p>You may request a copy, correction or deletion of your data by emailing <a href="mailto:{email}">{email}</a>.
Residents of California, the EU/UK and other regions with privacy laws have these rights as described by those laws.</p>

<h2>Changes</h2>
<p>If we change this policy we will update the date above and, for significant changes, notify you in the app.</p>

<h2>Contact</h2>
<p><a href="mailto:{email}">{email}</a></p>
""")


def _support() -> str:
    email = settings.SUPPORT_EMAIL
    return _page("Support", f"""
<h1>Vendora Support</h1>
<p>Need help? Email <a href="mailto:{email}">{email}</a> or use <strong>More &rarr; Support</strong> inside the app.
We usually reply within one business day (Partner members get priority).</p>
<h2>Common questions</h2>
<p><strong>Forgot your password?</strong> Tap "Forgot password?" on the sign-in screen and follow the email link.</p>
<p><strong>Restore a subscription on a new iPhone:</strong> Settings &rarr; Plans &amp; Billing &rarr; Restore Purchases.</p>
<p><strong>Cancel a subscription:</strong> bought in the iPhone app &rarr; your Apple ID's Subscriptions settings.
Bought on the web &rarr; Settings &rarr; Plans &amp; Billing &rarr; Manage Billing.</p>
<p><strong>Delete your account:</strong> Settings &rarr; Delete Account.</p>
<p><a href="/privacy">Privacy Policy</a></p>
""")


@router.get("/privacy", response_class=HTMLResponse, include_in_schema=False)
def privacy_policy() -> HTMLResponse:
    return HTMLResponse(_privacy(), headers=HEADERS)


@router.get("/support", response_class=HTMLResponse, include_in_schema=False)
def support_page() -> HTMLResponse:
    return HTMLResponse(_support(), headers=HEADERS)
