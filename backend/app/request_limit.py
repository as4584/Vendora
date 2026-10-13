"""Cap in-flight requests per process at the database pool's capacity.

A request holds one pooled connection from its first query until its session
closes, and in between it hops between thread-pool jobs (dependencies, the
endpoint, response serialization). When more requests are in flight than the
pool has connections, every worker thread can end up waiting for a connection
held by a request that is itself waiting for a thread: the API deadlocks and
does not recover (perf/REPORT.md). Admitting at most as many requests as the
pool can serve makes that impossible. Extra requests wait here, on the event
loop, and get a fast 503 if no slot frees up in time.
"""
import anyio
from starlette.types import ASGIApp, Receive, Scope, Send

# Liveness checks bypass the cap so a busy replica is not marked dead.
EXEMPT_PATHS = {"/api/v1/health"}
BUSY_BODY = b'{"detail":"Server busy, please retry."}'


class RequestLimitMiddleware:
    def __init__(self, app: ASGIApp, max_in_flight: int, queue_timeout: float) -> None:
        self.app = app
        self.max_in_flight = max_in_flight
        self.queue_timeout = queue_timeout
        self._slots: anyio.Semaphore | None = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return
        if self._slots is None:
            self._slots = anyio.Semaphore(self.max_in_flight)
        admitted = False
        # Only the wait for a slot is timed; an admitted request runs to completion.
        with anyio.move_on_after(self.queue_timeout):
            await self._slots.acquire()
            admitted = True
        if not admitted:
            await send({
                "type": "http.response.start",
                "status": 503,
                "headers": [(b"content-type", b"application/json"), (b"retry-after", b"2")],
            })
            await send({"type": "http.response.body", "body": BUSY_BODY})
            return
        try:
            await self.app(scope, receive, send)
        finally:
            self._slots.release()
