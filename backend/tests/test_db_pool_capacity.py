"""Regression: a DB pool smaller than the sync threadpool deadlocks the API.

Under load (~600 concurrent app users in perf/), all 40 AnyIO worker threads
blocked in get_current_user waiting for a connection while the 15 pooled
connections were held by requests that needed a free thread to finish.
"""
import anyio.to_thread

from app.database import engine


def test_db_pool_can_serve_every_worker_thread():
    async def limit():
        return anyio.to_thread.current_default_thread_limiter().total_tokens

    threads = anyio.run(limit)
    capacity = engine.pool.size() + engine.pool._max_overflow
    assert capacity >= threads, f"DB pool {capacity} < threadpool {threads}"


def test_auth_dependency_releases_its_transaction(db, test_user):
    """The auth check must not hold a DB transaction open while the request
    waits for a thread to run the endpoint; under load that deadlocks the API
    once every thread is waiting for a connection."""
    from fastapi.security import HTTPAuthorizationCredentials

    from app.dependencies.auth import get_current_user
    from app.services.auth import create_access_token

    token = create_access_token({"sub": str(test_user.id)})
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    user = get_current_user(creds, db)
    assert not db.in_transaction()
    assert user.id == test_user.id  # reloads in a new, short transaction


def test_in_flight_cap_fits_in_db_pool():
    """Each admitted request holds at most one connection, so admitting no more
    requests than the pool holds means a checkout can never wait forever."""
    from app.config import settings

    capacity = engine.pool.size() + engine.pool._max_overflow
    assert settings.MAX_IN_FLIGHT_REQUESTS <= capacity
