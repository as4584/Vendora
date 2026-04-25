jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

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

describe('api base url selection', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('defaults to the local seeded backend url when no env override is set', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      makeFetchResponse({
        body: JSON.stringify({
          revenue_today: '0.00',
          revenue_week: '0.00',
          revenue_month: '0.00',
          net_profit_today: '0.00',
          net_profit_week: '0.00',
          net_profit_month: '0.00',
          net_profit_all_time: '0.00',
          total_inventory_value: '0.00',
          total_expected_value: '0.00',
          potential_profit: '0.00',
          total_items: 0,
          items_in_stock: 0,
          items_listed: 0,
          items_sold: 0,
          total_transactions: 0,
          total_refunds: 0,
        }),
      }),
    );

    let api!: typeof import('../services/api');
    jest.isolateModules(() => {
      api = require('../services/api');
    });
    await api.getDashboard();

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8001/api/v1/dashboard',
      expect.any(Object),
    );
  });

  it('uses EXPO_PUBLIC_API_BASE_URL when provided', async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://example.test/api/v1';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      makeFetchResponse({
        body: JSON.stringify({
          revenue_today: '0.00',
          revenue_week: '0.00',
          revenue_month: '0.00',
          net_profit_today: '0.00',
          net_profit_week: '0.00',
          net_profit_month: '0.00',
          net_profit_all_time: '0.00',
          total_inventory_value: '0.00',
          total_expected_value: '0.00',
          potential_profit: '0.00',
          total_items: 0,
          items_in_stock: 0,
          items_listed: 0,
          items_sold: 0,
          total_transactions: 0,
          total_refunds: 0,
        }),
      }),
    );

    let api!: typeof import('../services/api');
    jest.isolateModules(() => {
      api = require('../services/api');
    });
    await api.getDashboard();

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.test/api/v1/dashboard',
      expect.any(Object),
    );
  });
});
