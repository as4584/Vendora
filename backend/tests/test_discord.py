"""Unit tests for Discord webhook notifications (no network)."""
import httpx
import pytest

from app.services.discord import DiscordNotifyError, send_support_notification


class _Resp:
    def __init__(self, error=False):
        self.error = error

    def raise_for_status(self):
        if self.error:
            raise httpx.HTTPStatusError("rejected", request=None, response=None)


def test_requires_webhook_url(monkeypatch):
    monkeypatch.setattr("app.services.discord.settings.DISCORD_WEBHOOK_URL", "")
    with pytest.raises(DiscordNotifyError, match="not configured"):
        send_support_notification("user@test.com", "subject", "message", "standard")


def test_posts_priority_embed(monkeypatch):
    captured = {}
    monkeypatch.setattr("app.services.discord.settings.DISCORD_WEBHOOK_URL", "https://discord.test/webhook")

    def post(url, **kwargs):
        captured.update({"url": url, **kwargs})
        return _Resp()

    monkeypatch.setattr("app.services.discord.httpx.post", post)
    send_support_notification("user@test.com", "Need help", "Sync is stuck", "priority")

    assert captured["url"] == "https://discord.test/webhook"
    embed = captured["json"]["embeds"][0]
    assert embed["color"] == 0xF97316
    assert embed["fields"][0]["value"] == "user@test.com"
    assert embed["fields"][3]["value"] == "Sync is stuck"


def test_standard_uses_default_color(monkeypatch):
    captured = {}
    monkeypatch.setattr("app.services.discord.settings.DISCORD_WEBHOOK_URL", "https://discord.test/webhook")
    monkeypatch.setattr("app.services.discord.httpx.post", lambda url, **kw: captured.update(json=kw["json"]) or _Resp())
    send_support_notification("user@test.com", "Need help", "Sync is stuck", "standard")
    assert captured["json"]["embeds"][0]["color"] == 0x8B5CF6


def test_wraps_http_failure(monkeypatch):
    monkeypatch.setattr("app.services.discord.settings.DISCORD_WEBHOOK_URL", "https://discord.test/webhook")
    monkeypatch.setattr("app.services.discord.httpx.post", lambda *args, **kwargs: _Resp(error=True))
    with pytest.raises(DiscordNotifyError, match="rejected"):
        send_support_notification("user@test.com", "subject", "message", "standard")
