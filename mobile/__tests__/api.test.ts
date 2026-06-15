/**
 * api.ts regression tests
 *
 * Covers:
 *  1. Non-JSON (text/csv) OK response returns text, does not throw
 *  2. JSON OK response returns parsed object
 *  3. 401 response clears token and calls the registered handler
 *  4. 4xx response throws ApiError with correct status
 *  5. onUnauthorized handler registration replaces previous handler
 */

// Must mock AsyncStorage before importing api (it imports on module load)
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
    getAllKeys: jest.fn(async () => []),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from '../services/api';

// Cast AsyncStorage methods to jest.Mock for easy assertion.
const asyncStorageMock = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

// Helper: create a minimal Response-like object that mimics the fetch API.
function makeFetchResponse({
  status = 200,
  contentType = 'application/json',
  body = '',
}: {
  status?: number;
  contentType?: string;
  body?: string;
}): Response {
  const headers = new Headers({ 'content-type': contentType });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('api.ts — request()', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    // Reset async storage between tests
    (asyncStorageMock.getItem as jest.Mock).mockResolvedValue(null);
    (asyncStorageMock.removeItem as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    api.onUnauthorized(null as any); // clear handler
  });

  // ── 1. CSV (text/csv) OK response ────────────────────────────────────────
  it('returns text for a text/csv OK response (export crash regression)', async () => {
    const csvText = 'id,name\n1,Jordan';
    fetchSpy.mockResolvedValueOnce(
      makeFetchResponse({ status: 200, contentType: 'text/csv; charset=utf-8', body: csvText }),
    );

    const result = await api.listItems(); // any api call — we're testing the transport layer
    // The raw CSV string should be returned without throwing
    expect(result).toBe(csvText);
  });

  // ── 2. JSON OK response ───────────────────────────────────────────────────
  it('returns parsed JSON for an application/json OK response', async () => {
    const payload = { items: [], total: 0, page: 1, per_page: 20, pages: 0 };
    fetchSpy.mockResolvedValueOnce(
      makeFetchResponse({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      }),
    );

    const result = await api.listItems();
    expect(result).toEqual(payload);
  });

  // ── 3. 401 clears token and calls registered handler ─────────────────────
  it('clears stored token and invokes onUnauthorized handler on 401', async () => {
    (asyncStorageMock.getItem as jest.Mock).mockResolvedValue('stale-jwt');
    fetchSpy.mockResolvedValueOnce(
      makeFetchResponse({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Token expired' }),
      }),
    );

    const handler = jest.fn();
    api.onUnauthorized(handler);

    await expect(api.getMe()).rejects.toThrow();

    expect(asyncStorageMock.removeItem).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ── 4. 4xx throws ApiError with correct status ───────────────────────────
  it('throws ApiError with status 403 for a Pro-only endpoint response', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeFetchResponse({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ detail: { error: 'pro_required', message: 'Upgrade to Pro' } }),
      }),
    );

    try {
      await api.exportInventoryCSV();
      fail('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(api.ApiError);
      expect(err.status).toBe(403);
    }
  });

  // ── 5. Replacing the onUnauthorized handler ───────────────────────────────
  it('only the most recently registered onUnauthorized handler fires', async () => {
    (asyncStorageMock.getItem as jest.Mock).mockResolvedValue('stale-jwt');
    fetchSpy.mockResolvedValueOnce(
      makeFetchResponse({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Expired' }),
      }),
    );

    const first = jest.fn();
    const second = jest.fn();
    api.onUnauthorized(first);
    api.onUnauthorized(second);

    await expect(api.getMe()).rejects.toThrow();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('retries spreadsheet link import once after a gateway error', async () => {
    jest.useFakeTimers();
    try {
      fetchSpy
        .mockResolvedValueOnce(
          makeFetchResponse({
            status: 502,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'Bad Gateway' }),
          }),
        )
        .mockResolvedValueOnce(
          makeFetchResponse({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              dry_run: false,
              rows_seen: 40,
              rows_importable: 40,
              created: 40,
              updated: 0,
              skipped: 0,
              errors: [],
              warnings: [],
              sample_items: [],
            }),
          }),
        );

      const resultPromise = api.importInventoryFromLink(
        'https://docs.google.com/spreadsheets/d/example/edit?gid=0',
        false,
      );

      await jest.advanceTimersByTimeAsync(1800);
      const result = await resultPromise;

      expect(result.created).toBe(40);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
