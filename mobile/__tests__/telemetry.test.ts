
const mockRequest = jest.fn(() => Promise.resolve());
jest.mock('../services/api', () => ({ request: (...a: unknown[]) => mockRequest(...(a as [])) }));

let Sentry: Record<string, jest.Mock>;
function load(): typeof import('../services/telemetry') {
  jest.resetModules();
  Sentry = require('@sentry/react-native');
  return require('../services/telemetry');
}

beforeEach(() => jest.clearAllMocks());

it('stays off without a DSN', () => {
  const t = load();
  expect(t.initCrashReporting(undefined)).toBe(false);
  t.identify('u1');
  t.reportError(new Error('x'));
  expect(Sentry.init).not.toHaveBeenCalled();
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it('turns on once with a DSN, without PII', () => {
  const t = load();
  expect(t.initCrashReporting('https://k@o0.ingest.sentry.io/1')).toBe(true);
  expect(t.initCrashReporting('https://k@o0.ingest.sentry.io/1')).toBe(true);
  expect(Sentry.init).toHaveBeenCalledTimes(1);
  expect(Sentry.init.mock.calls[0][0].sendDefaultPii).toBe(false);
  t.identify('u1');
  expect(Sentry.setUser).toHaveBeenCalledWith({ id: 'u1' });
  t.identify(null);
  expect(Sentry.setUser).toHaveBeenLastCalledWith(null);
  t.reportError(new Error('boom'), 'sale');
  expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { context: 'sale' } });
  t.reportError(new Error('bare'));
  expect(Sentry.captureException).toHaveBeenLastCalledWith(expect.any(Error), undefined);
});

it('posts events and swallows failures', async () => {
  const t = load();
  t.track('paywall_view', { source: 'x' });
  expect(mockRequest).toHaveBeenCalledWith('/events', { method: 'POST', body: JSON.stringify({ name: 'paywall_view', props: { source: 'x' } }) });
  mockRequest.mockImplementationOnce(() => Promise.reject(new Error('offline')));
  expect(() => t.track('app_open')).not.toThrow();
  await Promise.resolve();
  mockRequest.mockImplementationOnce(() => { throw new Error('sync'); });
  expect(() => t.track('app_open')).not.toThrow();
});
