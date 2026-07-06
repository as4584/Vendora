"""Discord webhook notifications for Vendora team alerts."""
import httpx

from app.config import settings


class DiscordNotifyError(RuntimeError):
    """Raised when Discord will not accept a webhook message."""


def send_support_notification(email: str, subject: str, message: str, priority: str) -> None:
    """Post an in-app support request to the team Discord channel."""
    if not settings.DISCORD_WEBHOOK_URL:
        raise DiscordNotifyError("DISCORD_WEBHOOK_URL is not configured")
    color = {"priority": 0xF97316}.get(priority, 0x8B5CF6)
    payload = {
        "username": "Vendora Support",
        "embeds": [
            {
                "title": f"🛟 New {priority} support request",
                "color": color,
                "fields": [
                    {"name": "From", "value": email[:1000], "inline": True},
                    {"name": "Priority", "value": priority[:1000], "inline": True},
                    {"name": "Subject", "value": subject[:1000], "inline": False},
                    {"name": "Message", "value": message[:1000], "inline": False},
                ],
            }
        ],
    }
    try:
        response = httpx.post(settings.DISCORD_WEBHOOK_URL, json=payload, timeout=10.0)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise DiscordNotifyError("Discord rejected the notification") from exc
