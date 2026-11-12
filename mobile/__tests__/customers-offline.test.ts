import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from '../services/api';
import { captureSession, replaceSession } from '../services/session';

const store: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => store[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => { store[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete store[k]; }),
  },
}));

const CUSTOMERS = [
  { id: 'c-1', name: 'Marcus Reed', email: 'marcus@example.com', phone: null },
  { id: 'c-2', name: 'Dana Cards', email: null, phone: '7325550199' },
];
const CUSTOMER_KEY = 'account:v1:seller:offline:customers';

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe('listCustomers offline fallback', () => {
  const fetchMock = jest.spyOn(global, 'fetch');

  beforeEach(async () => {
    fetchMock.mockReset();
    for (const k of Object.keys(store)) delete store[k];
    replaceSession();
    const token = `x.${Buffer.from(JSON.stringify({ sub: 'seller' })).toString('base64url')}.x`;
    await api.setSession(token, 'test-refresh');
    api.activateAccount('seller', captureSession());
  });

  it('caches the full list and serves (filtered) copies when the network fails', async () => {
    fetchMock.mockResolvedValueOnce(ok({ items: CUSTOMERS, total: 2 }));
    expect(await api.listCustomers()).toHaveLength(2);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(CUSTOMER_KEY, JSON.stringify(CUSTOMERS));

    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    expect((await api.listCustomers()).map((c) => c.id)).toEqual(['c-1', 'c-2']);
    expect((await api.listCustomers('7325')).map((c) => c.id)).toEqual(['c-2']);
    expect((await api.listCustomers('MARCUS')).map((c) => c.id)).toEqual(['c-1']);
  });

  it('throws when offline with nothing cached, and survives a corrupt cache', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await expect(api.listCustomers()).rejects.toBeTruthy();
    store[CUSTOMER_KEY] = '{not json';
    await expect(api.listCustomers()).rejects.toBeTruthy();
  });

  it('keeps working when the cache write fails', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    fetchMock.mockResolvedValueOnce(ok({ items: CUSTOMERS, total: 2 }));
    expect(await api.listCustomers()).toHaveLength(2);
  });
});
