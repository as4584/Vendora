"""Infrastructure, startup, database lifecycle, and transactional email tests."""
import httpx
import pytest

from app.services.email import EmailDeliveryError, send_password_reset_email


class _EmailResponse:
    def __init__(self, error=False):
        self.error = error

    def raise_for_status(self):
        if self.error:
            raise httpx.HTTPStatusError("rejected", request=None, response=None)


def test_password_reset_email_requires_resend_key(monkeypatch):
    monkeypatch.setattr("app.services.email.settings.RESEND_API_KEY", "")
    with pytest.raises(EmailDeliveryError, match="not configured"):
        send_password_reset_email("user@example.com", "token")


def test_password_reset_email_builds_safe_text_and_html_payload(monkeypatch):
    captured = {}
    monkeypatch.setattr("app.services.email.settings.RESEND_API_KEY", "resend-test-key")
    monkeypatch.setattr("app.services.email.settings.EMAIL_FROM_NAME", "Vendora")
    monkeypatch.setattr("app.services.email.settings.EMAIL_FROM_EMAIL", "noreply@lexmakesit.com")
    monkeypatch.setattr(
        "app.services.email.settings.PASSWORD_RESET_URL",
        "vendora://reset-password?source=a&unsafe=\"quoted\"",
    )

    def post(url, **kwargs):
        captured.update({"url": url, **kwargs})
        return _EmailResponse()

    monkeypatch.setattr("app.services.email.httpx.post", post)
    send_password_reset_email("user@example.com", "token with spaces")

    assert captured["url"] == "https://api.resend.com/emails"
    assert captured["headers"]["Authorization"] == "Bearer resend-test-key"
    payload = captured["json"]
    assert payload["from"] == "Vendora <noreply@lexmakesit.com>"
    assert payload["to"] == ["user@example.com"]
    assert "token+with+spaces" in payload["text"]
    assert "&quot;quoted&quot;" in payload["html"]


def test_password_reset_email_uses_bare_from_without_name(monkeypatch):
    captured = {}
    monkeypatch.setattr("app.services.email.settings.RESEND_API_KEY", "resend-test-key")
    monkeypatch.setattr("app.services.email.settings.EMAIL_FROM_NAME", "")
    monkeypatch.setattr("app.services.email.settings.EMAIL_FROM_EMAIL", "noreply@lexmakesit.com")

    def post(url, **kwargs):
        captured.update({"url": url, **kwargs})
        return _EmailResponse()

    monkeypatch.setattr("app.services.email.httpx.post", post)
    send_password_reset_email("user@example.com", "token")

    assert captured["json"]["from"] == "noreply@lexmakesit.com"


def test_password_reset_email_wraps_provider_http_failure(monkeypatch):
    monkeypatch.setattr("app.services.email.settings.RESEND_API_KEY", "resend-test-key")
    monkeypatch.setattr(
        "app.services.email.httpx.post",
        lambda *args, **kwargs: _EmailResponse(error=True),
    )
    with pytest.raises(EmailDeliveryError, match="rejected"):
        send_password_reset_email("user@example.com", "token")


def test_get_db_always_closes_session(monkeypatch):
    from app import database

    class FakeSession:
        closed = False

        def close(self):
            self.closed = True

    session = FakeSession()
    monkeypatch.setattr(database, "SessionLocal", lambda: session)
    dependency = database.get_db()
    assert next(dependency) is session
    dependency.close()
    assert session.closed is True


@pytest.mark.asyncio
async def test_lifespan_rejects_weak_production_secret(monkeypatch):
    from app import main

    monkeypatch.setattr(main.settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(main.settings, "SECRET_KEY", "weak")
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        async with main.lifespan(main.app):
            pass


@pytest.mark.asyncio
async def test_lifespan_skips_migrations_in_testing(monkeypatch):
    from app import main

    monkeypatch.setattr(main.settings, "ENVIRONMENT", "testing")
    monkeypatch.setattr(
        main.alembic_command,
        "upgrade",
        lambda *args: (_ for _ in ()).throw(AssertionError("must not migrate")),
    )
    async with main.lifespan(main.app):
        pass


@pytest.mark.asyncio
async def test_lifespan_runs_code_relative_migrations(monkeypatch):
    from app import main

    called = {}
    monkeypatch.setattr(main.settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(main.alembic_command, "upgrade", lambda cfg, rev: called.update(revision=rev))
    async with main.lifespan(main.app):
        pass
    assert called == {"revision": "head"}
