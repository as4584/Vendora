"""Transactional email delivery for Vendora."""
import html
from urllib.parse import urlencode

import httpx

from app.config import settings


class EmailDeliveryError(RuntimeError):
    """Raised when a transactional email cannot be accepted by SendGrid."""


def send_password_reset_email(email: str, token: str) -> None:
    """Send a password reset link through SendGrid."""
    if not settings.SENDGRID_API:
        raise EmailDeliveryError("SENDGRID_API is not configured")

    reset_url = f"{settings.PASSWORD_RESET_URL}?{urlencode({'token': token})}"
    safe_url = html.escape(reset_url, quote=True)
    minutes = settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES
    payload = {
        "personalizations": [{"to": [{"email": email}]}],
        "from": {
            "email": settings.SENDGRID_FROM_EMAIL,
            "name": settings.SENDGRID_FROM_NAME,
        },
        "subject": "Reset your Vendora password",
        "content": [
            {
                "type": "text/plain",
                "value": (
                    "We received a request to reset your Vendora password.\n\n"
                    f"Open this link within {minutes} minutes:\n{reset_url}\n\n"
                    "If you did not request this, you can ignore this email."
                ),
            },
            {
                "type": "text/html",
                "value": (
                    "<h2>Reset your Vendora password</h2>"
                    "<p>We received a request to reset your password.</p>"
                    f'<p><a href="{safe_url}">Reset password</a></p>'
                    f"<p>This link expires in {minutes} minutes.</p>"
                    "<p>If you did not request this, you can ignore this email.</p>"
                ),
            },
        ],
    }

    try:
        response = httpx.post(
            "https://api.sendgrid.com/v3/mail/send",
            headers={
                "Authorization": f"Bearer {settings.SENDGRID_API}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=10.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise EmailDeliveryError("SendGrid rejected the password reset email") from exc
