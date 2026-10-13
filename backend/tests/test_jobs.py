"""Slow outbound calls run on the job queue; without Redis they still happen inline."""
import pytest
from fakeredis import FakeStrictRedis
from redis.exceptions import ConnectionError as RedisConnectionError
from rq import Queue, SimpleWorker

from app import jobs
from app.config import settings
from app.rate_limit import limiter_storage

calls: list[tuple] = []


def record(*args):
    calls.append(args)


def explode(*args):
    raise RuntimeError("provider down")


@pytest.fixture(autouse=True)
def _reset():
    calls.clear()
    jobs._queue.cache_clear()
    yield
    jobs._queue.cache_clear()


@pytest.fixture
def fake_queue(monkeypatch):
    queue = Queue(jobs.QUEUE_NAME, connection=FakeStrictRedis())
    monkeypatch.setattr(jobs, "_queue", lambda: queue)
    return queue


def test_runs_inline_without_redis(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "")
    assert jobs.enqueue(record, "a", 1) is False
    assert calls == [("a", 1)]
    with pytest.raises(RuntimeError):
        jobs.enqueue(explode)


def test_queued_job_runs_on_worker_not_in_request(fake_queue):
    assert jobs.enqueue(record, "to@example.com", "tok") is True
    assert calls == []
    [job] = fake_queue.get_jobs()
    assert job.retries_left == len(jobs.RETRY_INTERVALS)
    # Worker logs print the description; it must not carry the token or address.
    assert job.description == "record"
    SimpleWorker([fake_queue], connection=fake_queue.connection).work(burst=True)
    assert calls == [("to@example.com", "tok")]


def test_falls_back_inline_when_redis_is_down(monkeypatch):
    class DownQueue:
        def enqueue(self, *a, **k):
            raise RedisConnectionError("no redis")

    monkeypatch.setattr(jobs, "_queue", lambda: DownQueue())
    assert jobs.enqueue(record, "x") is False
    assert calls == [("x",)]


def test_queue_built_from_redis_url_without_connecting(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://redis-does-not-exist:6379/0")
    queue = jobs._queue()
    assert queue.name == jobs.QUEUE_NAME
    assert jobs._queue() is queue


def test_rate_limits_shared_through_redis():
    assert limiter_storage("") == {}
    assert limiter_storage("redis://redis:6379/0") == {
        "storage_uri": "redis://redis:6379/0",
        "in_memory_fallback_enabled": True,
    }


def test_forgot_password_queues_the_email(client, test_user, monkeypatch):
    queued = []
    monkeypatch.setattr("app.routers.auth.enqueue", lambda func, *args: queued.append(func.__name__))
    for email in (test_user.email, "nobody-here@example.com"):
        assert client.post("/api/v1/auth/forgot-password", json={"email": email}).status_code == 202
    assert queued == ["send_password_reset_email", "send_no_account_email"]
