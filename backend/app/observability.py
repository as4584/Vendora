"""Crash and error reporting. Off unless SENTRY_DSN is set; sends no request bodies or PII."""
import logging

from app.config import settings

logger = logging.getLogger(__name__)


def init_sentry() -> bool:
    if not settings.SENTRY_DSN:
        return False
    import sentry_sdk

    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.ENVIRONMENT,
        send_default_pii=False,
        max_request_body_size="never",
        traces_sample_rate=0.0,
    )
    logger.info("Sentry error reporting enabled (%s)", settings.ENVIRONMENT)
    return True
