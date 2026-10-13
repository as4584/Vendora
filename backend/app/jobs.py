"""Background jobs: slow outbound calls (email, Discord) run off the request path.

With ``REDIS_URL`` set, ``enqueue`` hands the call to an RQ worker (the
``worker`` service in docker-compose.prod.yml), which retries transient
failures. Without it (tests, local dev), or if Redis is unreachable, the call
runs inline, so a Redis outage degrades latency, never delivery.

Job arguments sit in Redis until the job finishes. A password reset job holds
the raw reset token, which expires in PASSWORD_RESET_TOKEN_EXPIRE_MINUTES;
Redis is only reachable on the internal compose network.
"""
import logging
from functools import lru_cache
from typing import Any, Callable

from app.config import settings

logger = logging.getLogger(__name__)

QUEUE_NAME = "outbound"
# Retry after 10 s, 1 min, then 5 min: covers a provider blip without
# delivering a reset link after the token has expired.
RETRY_INTERVALS = [10, 60, 300]


@lru_cache(maxsize=1)
def _queue():
    if not settings.REDIS_URL:
        return None
    from redis import Redis
    from rq import Queue

    connection = Redis.from_url(settings.REDIS_URL, socket_connect_timeout=2, socket_timeout=2)
    return Queue(QUEUE_NAME, connection=connection, default_timeout=60)


def enqueue(func: Callable[..., Any], *args: Any) -> bool:
    """Run ``func(*args)`` in the background; return True if it was queued.

    When it cannot be queued it runs now, so exceptions from ``func`` reach
    the caller exactly as in a direct call.
    """
    queue = _queue()
    if queue is not None:
        from redis.exceptions import RedisError
        from rq import Retry

        try:
            queue.enqueue(
                func,
                *args,
                retry=Retry(max=len(RETRY_INTERVALS), interval=RETRY_INTERVALS),
                # The default description is the call with its arguments, which
                # the worker logs: that would put reset tokens and email
                # addresses in the logs. Log the function name only.
                description=func.__name__,
                result_ttl=0,
                failure_ttl=86400,
            )
            return True
        except RedisError:
            logger.warning("Job queue unavailable; running %s inline", func.__name__)
    func(*args)
    return False
