import * as api from '../services/api';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

function ok(body: unknown = {}, status = 200): Response {
  return {
    ok: true,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe('barcode control API', () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(ok({}));
  });
  afterAll(() => fetchMock.mockRestore());

  const last = () => {
    const [url, options = {}] = fetchMock.mock.calls.at(-1) as [string, RequestInit?];
    return { url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body as string) : undefined };
  };

  it('hits each endpoint with the right method and body', async () => {
    await api.resolveBarcode('STR 1/2');
    expect(last().url).toMatch(/\/scan\/resolve\?code=STR%201%2F2$/);

    await api.listBarcodeRules();
    expect(last()).toMatchObject({ method: 'GET' });
    expect(last().url).toMatch(/\/scan\/rules$/);

    await api.createBarcodeRule({ name: 'Tags', prefix: 'T' });
    expect(last()).toMatchObject({ method: 'POST', body: { name: 'Tags', prefix: 'T' } });

    await api.updateBarcodeRule('r1', { name: 'Tags', prefix: 'U' });
    expect(last()).toMatchObject({ method: 'PUT', body: { prefix: 'U' } });
    expect(last().url).toMatch(/\/scan\/rules\/r1$/);

    await api.reorderBarcodeRules(['b', 'a']);
    expect(last()).toMatchObject({ method: 'POST', body: { ids: ['b', 'a'] } });

    fetchMock.mockResolvedValueOnce(ok('', 204));
    await api.deleteBarcodeRule('r1');
    expect(last()).toMatchObject({ method: 'DELETE' });

    await api.listItemBarcodes('i1');
    expect(last().url).toMatch(/\/inventory\/i1\/barcodes$/);

    await api.linkBarcode('i1', 'TAG');
    expect(last()).toMatchObject({ method: 'POST', body: { code: 'TAG', replace: false } });

    fetchMock.mockResolvedValueOnce(ok('', 204));
    await api.unlinkBarcode('i1', 'A/B');
    expect(last()).toMatchObject({ method: 'DELETE' });
    expect(last().url).toMatch(/\/inventory\/i1\/barcodes\/A%2FB$/);

    await api.getResqloCode('i1');
    expect(last()).toMatchObject({ method: 'POST' });
    expect(last().url).toMatch(/\/inventory\/i1\/rq-code$/);
    await api.lookupCatalog('RQ-7F3K9XA');
    expect(last().url).toMatch(/\/catalog\/RQ-7F3K9XA$/);
    await api.getCatalogStats();
    expect(last().url).toMatch(/\/catalog\/stats$/);

    fetchMock.mockResolvedValueOnce(ok({ admin: true }));
    expect(await api.isCatalogAdmin()).toBe(true);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await api.isCatalogAdmin()).toBe(false);
    await api.searchCatalogAdmin('black cat');
    expect(last().url).toMatch(/\/catalog\/admin\/products\?q=black%20cat$/);
    await api.updateCatalogProduct('RQ-1', { name: 'A', style_code: 'B', size: null, brand: null, category: null, color: null });
    expect(last()).toMatchObject({ method: 'PUT', body: { name: 'A' } });
    fetchMock.mockResolvedValueOnce(ok('', 204));
    await api.deleteCatalogProduct('RQ-1');
    expect(last()).toMatchObject({ method: 'DELETE' });
    fetchMock.mockResolvedValueOnce(ok('', 204));
    await api.unlinkCatalogBarcode('123');
    expect(last().url).toMatch(/\/catalog\/admin\/barcodes\/123$/);
  });
});
