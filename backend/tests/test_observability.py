from app import observability


def test_sentry_off_without_dsn(monkeypatch):
    monkeypatch.setattr(observability.settings, "SENTRY_DSN", "")
    assert observability.init_sentry() is False


def test_sentry_on_with_dsn(monkeypatch):
    calls = {}
    import sentry_sdk

    monkeypatch.setattr(observability.settings, "SENTRY_DSN", "https://k@o0.ingest.sentry.io/1")
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: calls.update(kw))
    assert observability.init_sentry() is True
    assert calls["send_default_pii"] is False
