"""Requests beyond the in-flight cap queue, then get a fast 503; never deadlock."""
import anyio
import httpx

from app.request_limit import BUSY_BODY, RequestLimitMiddleware


def _app(max_in_flight, queue_timeout, gate):
    async def inner(scope, receive, send):
        await gate.wait()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    return RequestLimitMiddleware(inner, max_in_flight=max_in_flight, queue_timeout=queue_timeout)


async def _get(app, path="/api/v1/items"):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        return await c.get(path)


def test_excess_request_gets_503_after_queue_timeout():
    async def main():
        gate = anyio.Event()
        app = _app(1, 0.2, gate)
        results = {}

        async def call(name):
            results[name] = await _get(app)

        async with anyio.create_task_group() as tg:
            tg.start_soon(call, "first")
            await anyio.sleep(0.05)
            tg.start_soon(call, "second")
            await anyio.sleep(0.4)  # second times out while first holds the slot
            gate.set()
        return results

    results = anyio.run(main)
    assert results["first"].status_code == 200
    assert results["second"].status_code == 503
    assert results["second"].content == BUSY_BODY
    assert results["second"].headers["retry-after"] == "2"


def test_queued_request_runs_when_a_slot_frees():
    async def main():
        gate = anyio.Event()
        app = _app(1, 5, gate)
        results = []

        async def call():
            results.append((await _get(app)).status_code)

        async with anyio.create_task_group() as tg:
            tg.start_soon(call)
            tg.start_soon(call)
            await anyio.sleep(0.1)
            gate.set()
        return results

    assert anyio.run(main) == [200, 200]


def test_admitted_slow_request_is_not_cut_off():
    """Only the wait is timed: a request already running longer than the queue
    timeout (a big PDF export) must still complete."""
    async def main():
        gate = anyio.Event()
        app = _app(1, 0.05, gate)

        async def release_later():
            await anyio.sleep(0.2)
            gate.set()

        async with anyio.create_task_group() as tg:
            tg.start_soon(release_later)
            return await _get(app)

    assert anyio.run(main).status_code == 200


def test_health_and_non_http_bypass_the_cap():
    async def main():
        gate = anyio.Event()
        app = _app(1, 0.05, gate)
        app._slots = anyio.Semaphore(1)
        await app._slots.acquire()  # cap fully used
        gate.set()
        health = await _get(app, "/api/v1/health")
        seen = []

        async def inner(scope, receive, send):
            seen.append(scope["type"])

        await RequestLimitMiddleware(inner, 1, 0.05)({"type": "lifespan"}, None, None)
        return health, seen

    health, seen = anyio.run(main)
    assert health.status_code == 200
    assert seen == ["lifespan"]
