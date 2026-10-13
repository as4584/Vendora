"""Shared API rate limiter."""
import os

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


def client_ip(request: Request) -> str:
    """Rate-limit key: the real visitor IP.

    In production every request arrives from the Cloudflare tunnel container,
    so the socket address is the same for all users. Cloudflare sets
    CF-Connecting-IP; the backend port is bound to 127.0.0.1 and the edge
    network, so the header cannot be supplied by an outside client directly.
    """
    forwarded = request.headers.get("cf-connecting-ip", "").strip()
    return forwarded or get_remote_address(request)


def limiter_storage(redis_url: str) -> dict:
    """Counters live in Redis so every API process enforces one shared limit.

    Without Redis each process counts separately, and N processes would let a
    client make N times its limit. If Redis goes down, limits fall back to
    per-process memory instead of failing requests.
    """
    if not redis_url:
        return {}
    return {"storage_uri": redis_url, "in_memory_fallback_enabled": True}


_is_testing = os.getenv("ENVIRONMENT") == "testing"
_default_limits = [] if _is_testing else ["100/minute"]
limiter = Limiter(
    key_func=client_ip,
    default_limits=_default_limits,
    enabled=not _is_testing,
    **limiter_storage(os.getenv("REDIS_URL", "")),
)
