"""Transactional email delivery for Vendora.

Resend is the production provider. SMTP is an optional fallback that is only
used when ``SMTP_HOST`` is configured; production leaves it empty. See
docs/EMAIL_DELIVERY.md.
"""
import smtplib
from email.message import EmailMessage
from urllib.parse import urlencode

import httpx

from app.config import settings
from app.services.email_safety import (
    InvalidEmailAddress,
    escape_html,
    escape_html_multiline,
    format_mailbox,
    safe_header,
    validate_single_address,
)


class EmailDeliveryError(RuntimeError):
    """Raised when a transactional email cannot be accepted by the provider."""


def _send_email(
    to_email: str,
    subject: str,
    plain_text: str,
    html_text: str,
    reply_to: str | None = None,
) -> None:
    # Every header value is sanitized here, in one place, so no caller can
    # inject CR/LF or a second recipient.
    try:
        recipient = validate_single_address(to_email)
        from_address = format_mailbox(settings.EMAIL_FROM_NAME, settings.EMAIL_FROM_EMAIL)
    except InvalidEmailAddress as exc:
        raise EmailDeliveryError("Refusing to send to an invalid email address") from exc
    reply_address = None
    if reply_to:
        try:
            reply_address = validate_single_address(reply_to)
        except InvalidEmailAddress:
            # Reply-To is a convenience; send without it rather than drop the email.
            reply_address = None
    clean_subject = safe_header(subject)

    if settings.SMTP_HOST:
        _send_via_smtp(recipient, from_address, clean_subject, plain_text, html_text, reply_address)
        return

    if not settings.RESEND_API_KEY:
        raise EmailDeliveryError("No email provider is configured")
    payload = {
        "from": from_address,
        "to": [recipient],
        "subject": clean_subject,
        "text": plain_text,
        "html": html_text,
    }
    if reply_address:
        payload["reply_to"] = reply_address
    try:
        response = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}", "Content-Type": "application/json"},
            json=payload,
            timeout=10.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise EmailDeliveryError("Resend rejected the email") from exc


def _send_via_smtp(
    recipient: str,
    from_address: str,
    subject: str,
    plain_text: str,
    html_text: str,
    reply_address: str | None,
) -> None:
    if not settings.SMTP_USERNAME or not settings.SMTP_PASSWORD:
        raise EmailDeliveryError("SMTP credentials are not configured")
    message = EmailMessage()
    message["From"] = from_address
    message["To"] = recipient
    message["Subject"] = subject
    if reply_address:
        message["Reply-To"] = reply_address
    message.set_content(plain_text)
    message.add_alternative(html_text, subtype="html")
    try:
        if settings.SMTP_USE_TLS:
            with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as server:
                server.starttls()
                server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
                server.send_message(message)
        else:
            with smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as server:
                server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
                server.send_message(message)
    except (OSError, smtplib.SMTPException) as exc:
        raise EmailDeliveryError("SMTP rejected the email") from exc


def build_password_reset_url(token: str) -> str:
    """Build the link that goes in the reset email.

    For the HTTPS bridge page the token goes in the URL fragment, which
    browsers never send to the server, so it stays out of access logs,
    proxies and Referer headers. A custom-scheme URL (dev builds) keeps the
    query form the app route reads directly.
    """
    base = settings.PASSWORD_RESET_URL
    separator = "#" if base.startswith(("https://", "http://")) else ("&" if "?" in base else "?")
    return f"{base}{separator}{urlencode({'token': token})}"


def send_password_reset_email(email: str, token: str) -> None:
    """Send a password reset link."""
    reset_url = build_password_reset_url(token)
    safe_url = escape_html(reset_url)
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
    """Notify the support mailbox; all user content is escaped, never trusted as HTML."""
    _send_email(
        settings.SUPPORT_EMAIL,
        f"[{safe_header(priority, 20).upper()}] Vendora support: {subject}",
        f"From: {email}\nPriority: {priority}\n\n{message}",
        f"<p><strong>From:</strong> {escape_html(email)}</p>"
        f"<p><strong>Priority:</strong> {escape_html(priority)}</p>"
        f"<h3>{escape_html(subject)}</h3><p>{escape_html_multiline(message)}</p>",
        reply_to=email,
    )
