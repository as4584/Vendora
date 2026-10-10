"""Email header/body sanitization, the password-reset bridge page, CORS and
log redaction."""
import email
import logging
import re

import pytest

from app.main import RedactTokensFilter, build_allowed_origins, DEFAULT_ALLOWED_ORIGINS
from app.routers.reset_bridge import CONTENT_SECURITY_POLICY, PAGE
from app.services.email import (
    EmailDeliveryError,
    build_password_reset_url,
    send_password_reset_email,
    send_support_request_email,
)
from app.services.email_safety import (
    InvalidEmailAddress,
    format_mailbox,
    safe_header,
    validate_single_address,
)

INJECTION_PAYLOADS = [
    "Hello\r\nBcc: attacker@example.com",
    "Hello\nReply-To: attacker@example.com",
    "Hello\rX-Injected: yes",
    "\x00\x01Bad subject",
    "Hello Bcc: attacker@example.com",
    "Hello\x85Bcc: attacker@example.com",
]


class _Response:
    def raise_for_status(self):
        return None


@pytest.fixture()
def resend(monkeypatch):
    sent = []
    monkeypatch.setattr("app.services.email.settings.RESEND_API_KEY", "resend-test-key")
    monkeypatch.setattr("app.services.email.settings.SMTP_HOST", "")
    monkeypatch.setattr("app.services.email.settings.EMAIL_FROM_NAME", "Vendora")
    monkeypatch.setattr("app.services.email.settings.EMAIL_FROM_EMAIL", "noreply@lexmakesit.com")
    monkeypatch.setattr("app.services.email.settings.SUPPORT_EMAIL", "support@lexmakesit.com")

    def post(url, **kwargs):
        sent.append(kwargs["json"])
        return _Response()

    monkeypatch.setattr("app.services.email.httpx.post", post)
    return sent


@pytest.fixture()
def smtp(monkeypatch):
    sent = []

    class FakeSMTP:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def login(self, *args):
            pass

        def send_message(self, message):
            sent.append(message.as_bytes())

    monkeypatch.setattr("app.services.email.settings.SMTP_HOST", "smtp.example.com")
    monkeypatch.setattr("app.services.email.settings.SMTP_USERNAME", "user")
    monkeypatch.setattr("app.services.email.settings.SMTP_PASSWORD", "pass")
    monkeypatch.setattr("app.services.email.settings.SMTP_USE_TLS", False)
    monkeypatch.setattr("app.services.email.settings.EMAIL_FROM_NAME", "Vendora")
    monkeypatch.setattr("app.services.email.settings.EMAIL_FROM_EMAIL", "noreply@lexmakesit.com")
    monkeypatch.setattr("app.services.email.settings.SUPPORT_EMAIL", "support@lexmakesit.com")
    monkeypatch.setattr("app.services.email.smtplib.SMTP_SSL", FakeSMTP)
    return sent


# ─── safe_header ──────────────────────────────────────────────────────────────

class TestSafeHeader:
    def test_normal_subject_is_unchanged(self):
        assert safe_header("Normal subject") == "Normal subject"

    @pytest.mark.parametrize("payload", INJECTION_PAYLOADS)
    def test_injection_payloads_become_one_line(self, payload):
        result = safe_header(payload)
        assert not re.search(r"[\x00-\x1f\x7f-\x9f  ]", result)

    def test_collapses_whitespace_and_trims(self):
        assert safe_header("  a \t\t b \r\n c  ") == "a b c"

    def test_caps_length(self):
        assert len(safe_header("x" * 1000, max_length=50)) == 50

    def test_none_becomes_empty(self):
        assert safe_header(None) == ""


class TestSingleAddress:
    def test_accepts_one_plain_address(self):
        assert validate_single_address(" user@example.com ") == "user@example.com"

    @pytest.mark.parametrize("value", [
        "a@example.com,b@example.com",
        "a@example.com;b@example.com",
        "a@example.com b@example.com",
        "Name <a@example.com>",
        "a@example.com\r\nBcc: attacker@example.com",
        "a@example.com\nBcc: attacker@example.com",
        "not-an-address",
        "",
        "a@" + "x" * 260 + ".com",
    ])
    def test_rejects_anything_but_one_address(self, value):
        with pytest.raises(InvalidEmailAddress):
            validate_single_address(value)

    def test_display_name_is_sanitized_and_quoted(self):
        mailbox = format_mailbox('Evil\r\nBcc: x@example.com, "Co"', "noreply@lexmakesit.com")
        assert "\r" not in mailbox and "\n" not in mailbox
        name, address = email.utils.parseaddr(mailbox)
        assert address == "noreply@lexmakesit.com"


# ─── sending: no payload may create an extra header ───────────────────────────

class TestNoHeaderInjection:
    @pytest.mark.parametrize("payload", INJECTION_PAYLOADS)
    def test_resend_subject_is_single_line(self, resend, payload):
        send_support_request_email("user@example.com", payload, "A long enough message.", "standard")
        subject = resend[-1]["subject"]
        assert "\r" not in subject and "\n" not in subject
        assert resend[-1]["to"] == ["support@lexmakesit.com"]
        assert "bcc" not in resend[-1]

    @pytest.mark.parametrize("payload", INJECTION_PAYLOADS)
    def test_smtp_message_gets_no_extra_headers(self, smtp, payload):
        send_support_request_email("user@example.com", payload, "A long enough message.", "standard")
        parsed = email.message_from_bytes(smtp[-1])
        header_names = {name.lower() for name in parsed.keys()}
        assert header_names <= {"from", "to", "subject", "reply-to", "mime-version", "content-type"}
        assert parsed["To"] == "support@lexmakesit.com"
        assert parsed.get_all("Bcc") is None
        assert parsed.get_all("X-Injected") is None
        assert parsed["Reply-To"] == "user@example.com"

    def test_multi_recipient_to_is_refused(self, resend):
        with pytest.raises(EmailDeliveryError):
            send_password_reset_email("a@example.com,attacker@example.com", "t" * 64)
        assert resend == []

    def test_invalid_reply_to_is_dropped_not_fatal(self, resend):
        send_support_request_email("a@example.com\nBcc: x@example.com", "Help", "A long enough message.", "standard")
        assert "reply_to" not in resend[-1]

    def test_normal_support_email_still_sends(self, resend):
        send_support_request_email("user@example.com", "Billing question", "Line one\nLine two", "priority")
        sent = resend[-1]
        assert sent["subject"] == "[PRIORITY] Vendora support: Billing question"
        assert sent["reply_to"] == "user@example.com"
        assert "Line one<br>Line two" in sent["html"]


# ─── HTML bodies escape user content ──────────────────────────────────────────

class TestHtmlEscaping:
    @pytest.mark.parametrize("payload", [
        '<img src="https://evil.example/track.png">',
        '<a href="https://evil.example">Verify your account</a>',
        "<script>alert(1)</script>",
        '" onmouseover="alert(1)',
    ])
    def test_user_text_is_escaped_in_html(self, resend, payload):
        send_support_request_email("user@example.com", payload, payload + " padding text", "standard")
        body = resend[-1]["html"]
        assert "<img" not in body and "<script" not in body and '<a href="https://evil' not in body
        assert "&lt;" in body or "&quot;" in body


# ─── reset link + bridge page ─────────────────────────────────────────────────

class TestResetLink:
    def test_https_reset_link_carries_token_in_fragment(self, monkeypatch):
        monkeypatch.setattr(
            "app.services.email.settings.PASSWORD_RESET_URL",
            "https://vendora.lexmakesit.com/reset-password",
        )
        url = build_password_reset_url("abc_DEF-123")
        assert url == "https://vendora.lexmakesit.com/reset-password#token=abc_DEF-123"

    def test_custom_scheme_reset_link_uses_query(self, monkeypatch):
        monkeypatch.setattr("app.services.email.settings.PASSWORD_RESET_URL", "vendora://reset-password")
        assert build_password_reset_url("abc") == "vendora://reset-password?token=abc"


class TestResetBridgePage:
    def test_page_has_no_store_and_security_headers(self, client):
        resp = client.get("/reset-password", params={"token": "a" * 64})
        assert resp.status_code == 200
        assert resp.headers["cache-control"] == "no-store"
        assert resp.headers["pragma"] == "no-cache"
        assert resp.headers["referrer-policy"] == "no-referrer"
        assert resp.headers["x-content-type-options"] == "nosniff"
        csp = resp.headers["content-security-policy"]
        assert "default-src 'none'" in csp and "'unsafe-inline'" not in csp

    @pytest.mark.parametrize("token", [
        "a" * 64,
        "</script><script>alert(1)</script>",
        "';alert(1);//",
        "",
    ])
    def test_token_is_never_reflected_into_page(self, client, token):
        resp = client.get("/reset-password", params={"token": token})
        assert resp.status_code == 200
        assert resp.text == PAGE
        if token:
            assert token not in resp.text

    def test_page_without_token_still_serves_static_page(self, client):
        resp = client.get("/reset-password")
        assert resp.status_code == 200
        assert "This reset link is not valid" in resp.text

    def test_page_opens_existing_app_reset_route(self):
        assert "vendora://reset-password?token='+encodeURIComponent(token)" in PAGE
        assert "replaceState" in PAGE

    def test_csp_hashes_match_inline_blocks(self):
        import base64
        import hashlib
        for tag in ("script", "style"):
            body = re.search(rf"<{tag}>(.*?)</{tag}>", PAGE, re.S).group(1)
            digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
            assert f"'sha256-{digest}'" in CONTENT_SECURITY_POLICY


# ─── end-to-end: forgot → email → reset → login ───────────────────────────────

class TestResetEndToEnd:
    def test_full_reset_flow_without_support(self, client, db, resend, monkeypatch):
        monkeypatch.setattr(
            "app.services.email.settings.PASSWORD_RESET_URL",
            "https://vendora.lexmakesit.com/reset-password",
        )
        client.post("/api/v1/auth/register", json={"email": "flow@vendora.test", "password": "OldPassword1"})
        assert client.post("/api/v1/auth/forgot-password", json={"email": "flow@vendora.test"}).status_code == 202

        link = re.search(r"https://\S+", resend[-1]["text"]).group(0)
        assert "#token=" in link and "?token=" not in link
        token = link.split("#token=", 1)[1]
        assert client.get(link.split("#", 1)[0]).status_code == 200

        reset = client.post("/api/v1/auth/reset-password", json={"token": token, "password": "NewPassword1"})
        assert reset.status_code == 200
        assert client.post("/api/v1/auth/login", json={"email": "flow@vendora.test", "password": "NewPassword1"}).status_code == 200
        assert client.post("/api/v1/auth/login", json={"email": "flow@vendora.test", "password": "OldPassword1"}).status_code == 401
        # One-time token: a second use is rejected.
        again = client.post("/api/v1/auth/reset-password", json={"token": token, "password": "Another1234"})
        assert again.status_code == 400

    def test_malformed_token_is_rejected(self, client):
        resp = client.post("/api/v1/auth/reset-password", json={"token": "short", "password": "NewPassword1"})
        assert resp.status_code == 422

    def test_unknown_token_is_rejected(self, client):
        resp = client.post("/api/v1/auth/reset-password", json={"token": "x" * 64, "password": "NewPassword1"})
        assert resp.status_code == 400


# ─── CORS ─────────────────────────────────────────────────────────────────────

class TestCors:
    def test_production_only_allows_configured_origins(self):
        origins = build_allowed_origins("production", "https://vendora.lexmakesit.com")
        assert origins == ["https://vendora.lexmakesit.com"]

    def test_production_with_nothing_configured_allows_nothing(self):
        assert build_allowed_origins("production", "") == []

    def test_development_adds_localhost(self):
        origins = build_allowed_origins("development", "https://vendora.lexmakesit.com")
        assert origins[0] == "https://vendora.lexmakesit.com"
        assert set(DEFAULT_ALLOWED_ORIGINS) <= set(origins)


# ─── logs never contain reset tokens ──────────────────────────────────────────

def test_access_log_redacts_tokens():
    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 0,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:5", "GET", "/reset-password?token=SECRETTOKEN123&x=1", "1.1", 200),
        None,
    )
    RedactTokensFilter().filter(record)
    message = record.getMessage()
    assert "SECRETTOKEN123" not in message
    assert "token=[redacted]&x=1" in message


# ─── SMTP fallback branches ───────────────────────────────────────────────────

class TestSmtpFallback:
    def test_starttls_path(self, smtp, monkeypatch):
        calls = []

        class FakeTLS:
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def starttls(self):
                calls.append("starttls")

            def login(self, *args):
                pass

            def send_message(self, message):
                calls.append(message["To"])

        monkeypatch.setattr("app.services.email.settings.SMTP_USE_TLS", True)
        monkeypatch.setattr("app.services.email.smtplib.SMTP", FakeTLS)
        send_password_reset_email("user@example.com", "t" * 64)
        assert calls == ["starttls", "user@example.com"]

    def test_missing_smtp_credentials(self, smtp, monkeypatch):
        monkeypatch.setattr("app.services.email.settings.SMTP_PASSWORD", "")
        with pytest.raises(EmailDeliveryError, match="SMTP credentials"):
            send_password_reset_email("user@example.com", "t" * 64)

    def test_smtp_failure_is_wrapped(self, smtp, monkeypatch):
        import smtplib

        def boom(*args, **kwargs):
            raise smtplib.SMTPException("down")

        monkeypatch.setattr("app.services.email.smtplib.SMTP_SSL", boom)
        with pytest.raises(EmailDeliveryError, match="SMTP rejected"):
            send_password_reset_email("user@example.com", "t" * 64)

    def test_reset_link_appends_to_existing_query(self, monkeypatch):
        monkeypatch.setattr("app.services.email.settings.PASSWORD_RESET_URL", "vendora://reset-password?src=mail")
        assert build_password_reset_url("abc") == "vendora://reset-password?src=mail&token=abc"
