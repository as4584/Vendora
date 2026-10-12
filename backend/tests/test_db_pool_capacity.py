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
