"""Transactional email delivery for Vendora."""
import html
from urllib.parse import urlencode

import httpx

from app.config import settings


class EmailDeliveryError(RuntimeError):
    """Raised when a transactional email cannot be accepted by SendGrid."""


def _send_email(to_email: str, subject: str, plain_text: str, html_text: str) -> None:
    if not settings.SENDGRID_API:
        raise EmailDeliveryError("SENDGRID_API is not configured")
    payload = {
        "personalizations": [{"to": [{"email": to_email}]}],
        "from": {"email": settings.SENDGRID_FROM_EMAIL, "name": settings.SENDGRID_FROM_NAME},
        "subject": subject,
        "content": [
            {"type": "text/plain", "value": plain_text},
            {"type": "text/html", "value": html_text},
        ],
    }
    try:
        response = httpx.post(
            "https://api.sendgrid.com/v3/mail/send",
            headers={"Authorization": f"Bearer {settings.SENDGRID_API}", "Content-Type": "application/json"},
            json=payload,
            timeout=10.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise EmailDeliveryError("SendGrid rejected the email") from exc


def send_password_reset_email(email: str, token: str) -> None:
    """Send a password reset link through SendGrid."""
    reset_url = f"{settings.PASSWORD_RESET_URL}?{urlencode({'token': token})}"
    safe_url = html.escape(reset_url, quote=True)
    minutes = settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES
    _send_email(
        email,
        "Reset your Vendora password",
        "We received a request to reset your Vendora password.\n\n"
        f"Open this link within {minutes} minutes:\n{reset_url}\n\n"
        "If you did not request this, you can ignore this email.",
        "<h2>Reset your Vendora password</h2>"
        "<p>We received a request to reset your password.</p>"
        f'<p><a href="{safe_url}">Reset password</a></p>'
        f"<p>This link expires in {minutes} minutes.</p>"
        "<p>If you did not request this, you can ignore this email.</p>",
    )


def send_support_request_email(email: str, subject: str, message: str, priority: str) -> None:
    """Notify the support mailbox without exposing user content as HTML."""
    safe_subject = html.escape(subject)
    safe_message = html.escape(message).replace("\n", "<br>")
    _send_email(
        settings.SUPPORT_EMAIL,
        f"[{priority.upper()}] Vendora support: {subject}",
        f"From: {email}\nPriority: {priority}\n\n{message}",
        f"<p><strong>From:</strong> {html.escape(email)}</p>"
        f"<p><strong>Priority:</strong> {html.escape(priority)}</p>"
        f"<h3>{safe_subject}</h3><p>{safe_message}</p>",
    )
