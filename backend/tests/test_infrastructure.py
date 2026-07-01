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


def test_password_reset_email_requires_sendgrid_key(monkeypatch):
    monkeypatch.setattr("app.services.email.settings.SENDGRID_API", "")
    with pytest.raises(EmailDeliveryError, match="not configured"):
        send_password_reset_email("user@example.com", "token")


def test_password_reset_email_builds_safe_text_and_html_payload(monkeypatch):
    captured = {}
    monkeypatch.setattr("app.services.email.settings.SENDGRID_API", "sendgrid-test-key")
    monkeypatch.setattr(
        "app.services.email.settings.PASSWORD_RESET_URL",
        "vendora://reset-password?source=a&unsafe=\"quoted\"",
    )

    def post(url, **kwargs):
        captured.update({"url": url, **kwargs})
        return _EmailResponse()

    monkeypatch.setattr("app.services.email.httpx.post", post)
    send_password_reset_email("user@example.com", "token with spaces")

    assert captured["url"] == "https://api.sendgrid.com/v3/mail/send"
    assert captured["headers"]["Authorization"] == "Bearer sendgrid-test-key"
    payload = captured["json"]
    assert payload["personalizations"][0]["to"][0]["email"] == "user@example.com"
    assert "token+with+spaces" in payload["content"][0]["value"]
    assert "&quot;quoted&quot;" in payload["content"][1]["value"]


def test_password_reset_email_wraps_sendgrid_http_failure(monkeypatch):
    monkeypatch.setattr("app.services.email.settings.SENDGRID_API", "sendgrid-test-key")
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
