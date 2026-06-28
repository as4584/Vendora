"""Shared API rate limiter."""
import os

from slowapi import Limiter
from slowapi.util import get_remote_address


_default_limits = [] if os.getenv("ENVIRONMENT") == "testing" else ["100/minute"]
limiter = Limiter(key_func=get_remote_address, default_limits=_default_limits)
