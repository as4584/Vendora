import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import * as api from '../services/api';
import { replaceSession } from '../services/session';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

function response(body: unknown = {}, status = 200, contentType = 'application/json'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    text: jest.fn().mockResolvedValue(
      typeof body === 'string' ? body : JSON.stringify(body),
    ),
  } as unknown as Response;
}

function lastRequest(fetchMock: jest.Mock) {
  const [url, options = {}] = fetchMock.mock.calls.at(-1) as [string, RequestInit?];
  return { url, options };
}

function expectPath(url: string, path: string) {
  expect(url.endsWith(path)).toBe(true);
}

async function onWeb<T>(fn: () => Promise<T>): Promise<T> {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
  try { return await fn(); } finally { Object.defineProperty(Platform, 'OS', { value: original, configurable: true }); }
}

describe('Stripe subscription endpoints on iOS (Guideline 3.1.1)', () => {
  it('refuses to start Stripe checkout or the billing portal on iOS', async () => {
    const realFetch = global.fetch;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    try {
      await expect(api.createSubscriptionCheckout('pro')).rejects.toThrow(api.STRIPE_BLOCKED_ON_IOS);
      await expect(api.createBillingPortal()).rejects.toThrow(api.STRIPE_BLOCKED_ON_IOS);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
      global.fetch = realFetch;
    }
  });
});

describe('API endpoint contracts', () => {
  const fetchMock = jest.spyOn(global, 'fetch');

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(response({}));
    (SecureStore as any).__reset();
    jest.clearAllMocks();
  });

  afterAll(() => fetchMock.mockRestore());

  const cases: Array<{
    name: string;
    call: () => Promise<unknown>;
    path: string;
    method?: string;
    body?: unknown;
  }> = [
    { name: 'ebay policies', call: () => api.getEbayPolicies(), path: '/integrations/ebay/policies' },
    {
      name: 'setup ebay policies',
      call: () => api.setupEbayPolicies({ free_shipping: true, returns_accepted: false }),
      path: '/integrations/ebay/policies/setup',
      method: 'POST',
      body: { free_shipping: true, returns_accepted: false },
    },
    {
      name: 'setup ebay policies defaults',
      call: () => api.setupEbayPolicies(),
      path: '/integrations/ebay/policies/setup',
      method: 'POST',
      body: {},
    },
    { name: 'ebay listing status', call: () => api.getEbayListing('i 1'), path: '/integrations/ebay/listings/i%201' },
    {
      name: 'create ebay listing',
      call: () => api.createEbayListing({ item_id: 'i1', price: '10.00' }),
      path: '/integrations/ebay/listings',
      method: 'POST',
      body: { item_id: 'i1', price: '10.00' },
    },
    {
      name: 'update ebay listing',
      call: () => api.updateEbayListing('i1', { price: '9.00' }),
      path: '/integrations/ebay/listings/i1',
      method: 'PATCH',
      body: { price: '9.00' },
    },
    { name: 'end ebay listing', call: () => api.endEbayListing('i1'), path: '/integrations/ebay/listings/i1', method: 'DELETE' },
    { name: 'item ebay comps', call: () => api.getItemEbayComps('i1'), path: '/inventory/i1/ebay-comps' },
    { name: 'search ebay comps', call: () => api.searchEbayComps('air max'), path: '/integrations/ebay/comps?q=air%20max' },
    { name: 'outbox all', call: () => api.listOutboxJobs(), path: '/integrations/outbox' },
    { name: 'ebay traffic', call: () => api.getEbayTraffic('i1'), path: '/integrations/ebay/listings/i1/traffic' },
    { name: 'ebay traffic refresh', call: () => api.getEbayTraffic('i1', true), path: '/integrations/ebay/listings/i1/traffic?refresh=true' },
    { name: 'ebay offer eligibility', call: () => api.getEbayOfferEligibility('i1'), path: '/integrations/ebay/listings/i1/offers/eligibility' },
    {
      name: 'ebay send offer',
      call: () => api.sendEbayOffer('i1', { discount_percent: 10 }),
      path: '/integrations/ebay/listings/i1/offers',
      method: 'POST',
      body: { discount_percent: 10 },
    },
    { name: 'ebay finances sync', call: () => api.syncEbayFinances(), path: '/integrations/ebay/finances/sync', method: 'POST' },
    { name: 'ebay payouts', call: () => api.listEbayPayouts(), path: '/integrations/ebay/payouts' },
    { name: 'ebay fees', call: () => api.listEbayFees(), path: '/integrations/ebay/fees' },
    { name: 'outbox incl. done', call: () => api.listOutboxJobs(false), path: '/integrations/outbox?only_errors=false' },
    { name: 'retry outbox', call: () => api.retryOutboxJob('j1'), path: '/integrations/outbox/j1/retry', method: 'POST' },
    {
      name: 'show summary (server default window)',
      call: () => api.getShowSummary(),
      path: '/dashboard/show-summary',
    },
    {
      name: 'show summary window',
      call: () => api.getShowSummary({ since: '2026-11-02T00:00:00Z', until: '2026-11-03T00:00:00Z' }),
      path: '/dashboard/show-summary?since=2026-11-02T00%3A00%3A00Z&until=2026-11-03T00%3A00%3A00Z',
    },
    {
      name: 'show summary local today',
      call: () => api.getShowSummary({ tzOffsetMinutes: 300 }),
      path: '/dashboard/show-summary?tz_offset_minutes=300',
    },
    {
      name: 'start show now',
      call: () => api.startShow(),
      path: '/dashboard/show-start',
      method: 'PUT',
      body: {},
    },
    {
      name: 'start show at a time',
      call: () => api.startShow('2026-11-02T13:00:00Z'),
      path: '/dashboard/show-start',
      method: 'PUT',
      body: { started_at: '2026-11-02T13:00:00Z' },
    },
    {
      name: 'end show',
      call: () => api.endShow(),
      path: '/dashboard/show-start',
      method: 'DELETE',
    },
    {
      name: 'register',
      call: () => api.register('USER@EXAMPLE.COM', 'secret123', 'Shop'),
      path: '/auth/register',
      method: 'POST',
      body: { email: 'USER@EXAMPLE.COM', password: 'secret123', business_name: 'Shop' },
    },
    {
      name: 'register without business name',
      call: () => api.register('user@example.com', 'secret123'),
      path: '/auth/register',
      method: 'POST',
      body: { email: 'user@example.com', password: 'secret123', business_name: null },
    },
    {
      name: 'login',
      call: () => api.login('user@example.com', 'secret123'),
      path: '/auth/login',
      method: 'POST',
      body: { email: 'user@example.com', password: 'secret123' },
    },
    {
      name: 'delete account',
      call: () => api.deleteAccount('secret123'),
      path: '/auth/account',
      method: 'DELETE',
      body: { password: 'secret123', confirmation: 'DELETE' },
    },
    {
      name: 'forgot password',
      call: () => api.requestPasswordReset('user@example.com'),
      path: '/auth/forgot-password',
      method: 'POST',
      body: { email: 'user@example.com' },
    },
    {
      name: 'reset password',
      call: () => api.resetPassword('reset-token', 'new-secret'),
      path: '/auth/reset-password',
      method: 'POST',
      body: { token: 'reset-token', password: 'new-secret' },
    },
    { name: 'current user', call: () => api.getMe(), path: '/auth/me' },
    {
      name: 'profile update',
      call: () => api.updateProfile('New Shop', 'data:image/png;base64,AA=='),
      path: '/auth/profile',
      method: 'PATCH',
      body: { business_name: 'New Shop', profile_picture: 'data:image/png;base64,AA==' },
    },
    { name: 'invoice PDF', call: () => api.exportInvoicePdf('inv 1'), path: '/invoices/inv 1/pdf' },
    { name: 'item', call: () => api.getItem('item-1'), path: '/inventory/item-1' },
    {
      name: 'item activity default',
      call: () => api.getItemActivity('item-1'),
      path: '/inventory/item-1/activity?limit=25',
    },
    {
      name: 'item activity limit',
      call: () => api.getItemActivity('item-1', 5),
      path: '/inventory/item-1/activity?limit=5',
    },
    {
      name: 'create item',
      call: () => api.createItem({ name: 'Jordan 1', quantity: 2 }),
      path: '/inventory',
      method: 'POST',
      body: { name: 'Jordan 1', quantity: 2 },
    },
    {
      name: 'update item',
      call: () => api.updateItem('item-1', { quantity: 3 }),
      path: '/inventory/item-1',
      method: 'PUT',
      body: { quantity: 3 },
    },
    { name: 'delete item', call: () => api.deleteItem('item-1'), path: '/inventory/item-1', method: 'DELETE' },
    {
      name: 'item status',
      call: () => api.updateItemStatus('item-1', 'sold'),
      path: '/inventory/item-1/status',
      method: 'PATCH',
      body: { status: 'sold' },
    },
    {
      name: 'item photos',
      call: () => api.uploadItemPhotos('item-1', 'front'),
      path: '/inventory/item-1/photos',
      method: 'PATCH',
      body: { photo_front: 'front', photo_back: null },
    },
    {
      name: 'import commit',
      call: () => api.commitInventoryImport('job-1'),
      path: '/inventory/imports/job-1/commit',
      method: 'POST',
    },
    {
      name: 'create transaction',
      call: () => api.createTransaction({ method: 'cash', gross_amount: '20.00' }),
      path: '/transactions',
      method: 'POST',
      body: { method: 'cash', gross_amount: '20.00', client_request_id: expect.any(String) },
    },
    {
      name: 'refund transaction',
      call: () => api.refundTransaction('tx-1', 'returned'),
      path: '/transactions/tx-1/refund',
      method: 'POST',
      body: { reason: 'returned' },
    },
    {
      name: 'refund without reason',
      call: () => api.refundTransaction('tx-1'),
      path: '/transactions/tx-1/refund',
      method: 'POST',
      body: { reason: null },
    },
    { name: 'dashboard', call: () => api.getDashboard(), path: '/dashboard' },
    {
      name: 'create invoice',
      call: () => api.createInvoice({ customer_name: 'Sam', items: [] }),
      path: '/invoices',
      method: 'POST',
      // Always carries an idempotency key so a retried create never duplicates.
      body: { customer_name: 'Sam', items: [], client_request_id: expect.stringMatching(/^inv_/) },
    },
    {
      name: 'record invoice payment',
      call: () => api.recordInvoicePayment('inv-1', { amount: '20.00', method: 'card', client_request_id: 'pay-key-1' }),
      path: '/invoices/inv-1/payments',
      method: 'POST',
      body: { amount: '20.00', method: 'card', client_request_id: 'pay-key-1' },
    },
    { name: 'invoice', call: () => api.getInvoice('inv-1'), path: '/invoices/inv-1' },
    {
      name: 'invoice status',
      call: () => api.updateInvoiceStatus('inv-1', 'paid'),
      path: '/invoices/inv-1/status',
      method: 'PATCH',
      body: { status: 'paid' },
    },
    { name: 'subscription status', call: () => api.getSubscriptionStatus(), path: '/subscriptions/me' },
    { name: 'subscription checkout', call: () => onWeb(() => api.createSubscriptionCheckout('partner')), path: '/subscriptions/checkout', method: 'POST', body: { plan: 'partner' } },
    { name: 'billing portal', call: () => onWeb(() => api.createBillingPortal()), path: '/subscriptions/portal', method: 'POST' },
    { name: 'support request', call: () => api.submitSupportRequest('Help', 'Something broke'), path: '/support', method: 'POST', body: { subject: 'Help', message: 'Something broke' } },
    { name: 'advanced analytics default', call: () => api.getAdvancedAnalytics(), path: '/dashboard/advanced?days=30' },
    { name: 'advanced analytics range', call: () => api.getAdvancedAnalytics(90), path: '/dashboard/advanced?days=90' },
    { name: 'customers', call: () => api.listCustomers(), path: '/customers' },
    { name: 'customer search', call: () => api.listCustomers('kim'), path: '/customers?q=kim' },
    { name: 'customer', call: () => api.getCustomer('c-1'), path: '/customers/c-1' },
    {
      name: 'create customer',
      call: () => api.createCustomer({ name: 'Kim' }),
      path: '/customers',
      method: 'POST',
      body: { name: 'Kim' },
    },
    {
      name: 'update customer',
      call: () => api.updateCustomer('c-1', { tax_exempt: true }),
      path: '/customers/c-1',
      method: 'PATCH',
      body: { tax_exempt: true },
    },
    { name: 'disconnect square', call: () => api.disconnectSquare(), path: '/integrations/square', method: 'DELETE' },
    { name: 'disconnect clover', call: () => api.disconnectClover(), path: '/integrations/clover', method: 'DELETE' },
    {
      name: 'warehouse CSV',
      call: () => api.exportInventoryWarehouseCSV(),
      path: '/export/inventory?template=warehouse',
    },
    { name: 'transactions CSV', call: () => api.exportTransactionsCSV(), path: '/export/transactions' },
    { name: 'seller profile', call: () => api.getSellerProfile('user-1'), path: '/sellers/user-1' },
    {
      name: 'pricing suggestion',
      call: () => api.getPricingSuggestion('item-1'),
      path: '/inventory/item-1/pricing-suggestion',
    },
    {
      name: 'Lightspeed status',
      call: () => api.getLightspeedStatus(),
      path: '/integrations/lightspeed/status',
    },
    {
      name: 'Lightspeed connect URL',
      call: () => api.getLightspeedConnectUrl(),
      path: '/integrations/lightspeed/connect',
    },
    {
      name: 'Lightspeed sync',
      call: () => api.triggerLightspeedSync(),
      path: '/integrations/lightspeed/sync',
      method: 'POST',
    },
    { name: 'Lightspeed push', call: () => api.pushLightspeedInventory(), path: '/integrations/lightspeed/push', method: 'POST' },
    { name: 'Lightspeed item push', call: () => api.pushItemToLightspeed('item-1'), path: '/integrations/lightspeed/items/item-1/push', method: 'POST' },
    { name: 'Lightspeed disconnect', call: () => api.disconnectLightspeed(), path: '/integrations/lightspeed', method: 'DELETE' },
    {
      name: 'bulk delete items',
      call: () => api.bulkDeleteItems(['a', 'b'], true),
      path: '/inventory/bulk-delete',
      method: 'POST',
      body: { item_ids: ['a', 'b'], delete_from_source: true },
    },
    { name: 'eBay status', call: () => api.getEbayStatus(), path: '/integrations/ebay/status' },
    { name: 'eBay connect', call: () => api.getEbayConnectUrl(), path: '/integrations/ebay/connect' },
    { name: 'eBay sync', call: () => api.triggerEbaySync(), path: '/integrations/ebay/sync', method: 'POST' },
    { name: 'eBay disconnect', call: () => api.disconnectEbay(), path: '/integrations/ebay', method: 'DELETE' },
    { name: 'Square status', call: () => api.getSquareStatus(), path: '/integrations/square/status' },
    {
      name: 'Square connect',
      call: () => api.connectSquare({ access_token: 'square-token', merchant_id: 'merchant-1' }),
      path: '/integrations/square/connect',
      method: 'POST',
      body: { access_token: 'square-token', merchant_id: 'merchant-1' },
    },
    {
      name: 'Square sync',
      call: () => api.triggerSquareSync(),
      path: '/integrations/square/sync',
      method: 'POST',
    },
    { name: 'Clover status', call: () => api.getCloverStatus(), path: '/integrations/clover/status' },
    {
      name: 'Clover connect',
      call: () => api.connectClover({ access_token: 'clover-token', merchant_id: 'merchant-1' }),
      path: '/integrations/clover/connect',
      method: 'POST',
      body: { access_token: 'clover-token', merchant_id: 'merchant-1' },
    },
    {
      name: 'Clover sync',
      call: () => api.triggerCloverSync(),
      path: '/integrations/clover/sync',
      method: 'POST',
    },
    { name: 'provider health', call: () => api.getProviderHealth(), path: '/integrations/health' },
    {
      name: 'retry sync run',
      call: () => api.retrySyncRun('run-1'),
      path: '/integrations/sync-runs/run-1/retry',
      method: 'POST',
    },
    {
      name: 'update reconciliation issue',
      call: () => api.updateReconciliationIssue('issue-1', { status: 'resolved', resolution_note: 'fixed' }),
      path: '/integrations/reconciliation-issues/issue-1',
      method: 'PATCH',
      body: { status: 'resolved', resolution_note: 'fixed' },
    },
    { name: 'health check', call: () => api.healthCheck(), path: '/health' },
    { name: 'stockx status', call: () => api.getStockxStatus(), path: '/integrations/stockx/status' },
    { name: 'stockx connect', call: () => api.getStockxConnectUrl(), path: '/integrations/stockx/connect' },
    { name: 'stockx disconnect', call: () => api.disconnectStockx(), path: '/integrations/stockx', method: 'DELETE' },
    { name: 'stockx sync', call: () => api.syncStockx(), path: '/integrations/stockx/sync', method: 'POST' },
    { name: 'stockx item', call: () => api.getStockxItem('i1'), path: '/integrations/stockx/items/i1' },
    { name: 'stockx match', call: () => api.getStockxMatch('i1'), path: '/integrations/stockx/items/i1/match' },
    {
      name: 'stockx confirm match',
      call: () => api.confirmStockxMatch('i1', 'p1'),
      path: '/integrations/stockx/items/i1/match',
      method: 'POST',
      body: { product_id: 'p1', sizes: {} },
    },
    { name: 'stockx market', call: () => api.getStockxMarket('i1'), path: '/integrations/stockx/items/i1/market' },
    { name: 'stockx quote', call: () => api.getStockxQuote('aj1', '10'), path: '/integrations/stockx/quote?query=aj1&size=10' },
    { name: 'stockx quote no size', call: () => api.getStockxQuote('aj1'), path: '/integrations/stockx/quote?query=aj1' },
    {
      name: 'stockx place ask',
      call: () => api.placeStockxAsk('i1', 'v1', '200.00'),
      path: '/integrations/stockx/items/i1/listings',
      method: 'POST',
      body: { variant_id: 'v1', amount: '200.00' },
    },
    {
      name: 'stockx update ask',
      call: () => api.updateStockxAsk('l1', '190.00'),
      path: '/integrations/stockx/listings/l1',
      method: 'PATCH',
      body: { amount: '190.00' },
    },
    { name: 'stockx remove ask', call: () => api.removeStockxAsk('l1'), path: '/integrations/stockx/listings/l1', method: 'DELETE' },
  ];

  test.each(cases)('$name sends the expected request', async ({ call, path, method, body }) => {
    await call();
    const { url, options } = lastRequest(fetchMock as unknown as jest.Mock);
    expectPath(url, path);
    expect(options.method ?? 'GET').toBe(method ?? 'GET');
    if (body !== undefined) expect(JSON.parse(options.body as string)).toEqual(body);
  });

  it('builds the xlsx export URL', () => {
    expect(api.exportInventoryXlsxUrl()).toMatch(/\/export\/inventory\?format=xlsx$/);
  });

  it('builds list query strings for numeric and filtered forms', async () => {
    await api.listItems(2, 50);
    expectPath(lastRequest(fetchMock as unknown as jest.Mock).url, '/inventory?page=2&per_page=50');

    await api.listItems({ page: 3, perPage: 10, q: 'shoe', status: 'listed', source: 'square', availableOnly: true });
    expectPath(
      lastRequest(fetchMock as unknown as jest.Mock).url,
      '/inventory?page=3&per_page=10&q=shoe&status=listed&source=square&available_only=true',
    );

    await api.listItems({ upc: '012345678905', perPage: 5 });
    expectPath(lastRequest(fetchMock as unknown as jest.Mock).url, '/inventory?page=1&per_page=5&upc=012345678905');

    await api.listTransactions(2, 40);
    expectPath(lastRequest(fetchMock as unknown as jest.Mock).url, '/transactions?page=2&per_page=40');
    await api.listTransactions({ page: 3, perPage: 5, itemId: 'item-1' });
    expectPath(
      lastRequest(fetchMock as unknown as jest.Mock).url,
      '/transactions?page=3&per_page=5&item_id=item-1',
    );

    await api.listInvoices(4, 30);
    expectPath(lastRequest(fetchMock as unknown as jest.Mock).url, '/invoices?page=4&per_page=30');
    await api.listInvoices({ page: 2, perPage: 7, status: 'paid', inventoryItemId: 'item-1' });
    expectPath(
      lastRequest(fetchMock as unknown as jest.Mock).url,
      '/invoices?page=2&per_page=7&status=paid&inventory_item_id=item-1',
    );
  });

  it('builds optional integration and pricing query strings', async () => {
    await api.getMarketPrice('Jordan 1');
    expectPath(
      lastRequest(fetchMock as unknown as jest.Mock).url,
      '/inventory/market-price?query=Jordan+1',
    );
    await api.getMarketPrice('Jordan 1', '0123');
    expectPath(
      lastRequest(fetchMock as unknown as jest.Mock).url,
      '/inventory/market-price?query=Jordan+1&upc=0123',
    );

    await api.listSyncRuns();
    expectPath(lastRequest(fetchMock as unknown as jest.Mock).url, '/integrations/sync-runs');
    await api.listSyncRuns({ provider: 'square', limit: 4 });
    expectPath(
      lastRequest(fetchMock as unknown as jest.Mock).url,
      '/integrations/sync-runs?provider=square&limit=4',
    );

    await api.listReconciliationIssues();
    expectPath(
      lastRequest(fetchMock as unknown as jest.Mock).url,
      '/integrations/reconciliation-issues',
    );
    await api.listReconciliationIssues({ provider: 'clover', status: 'open', limit: 8 });
    expectPath(
      lastRequest(fetchMock as unknown as jest.Mock).url,
      '/integrations/reconciliation-issues?provider=clover&status=open&limit=8',
    );
  });

  it('preserves existing custom attributes when saving variants', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ custom_attributes: { brand: 'Nike' } }))
      .mockResolvedValueOnce(response({ id: 'item-1' }));
    await api.updateItemVariants('item-1', [{ size: '10', quantity: 2 }]);
    const { options } = lastRequest(fetchMock as unknown as jest.Mock);
    expect(JSON.parse(options.body as string)).toEqual({
      custom_attributes: { brand: 'Nike', variants: [{ size: '10', quantity: 2 }] },
    });
  });

  it('uses an empty attribute object when saving variants on a new item', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ custom_attributes: null }))
      .mockResolvedValueOnce(response({ id: 'item-1' }));
    await api.updateItemVariants('item-1', []);
    const { options } = lastRequest(fetchMock as unknown as jest.Mock);
    expect(JSON.parse(options.body as string)).toEqual({ custom_attributes: { variants: [] } });
  });

  it('uploads preview and import files as FormData with defaults and overrides', async () => {
    const preview = new FormData();
    await api.previewInventoryImport(preview);
    let request = lastRequest(fetchMock as unknown as jest.Mock);
    expect(request.options.body).toBe(preview);
    expect((request.options.headers as Record<string, string>)['Content-Type']).toBeUndefined();

    await api.importInventoryFile({ uri: 'file:///one.csv', name: 'one.csv' });
    request = lastRequest(fetchMock as unknown as jest.Mock);
    expectPath(request.url, '/inventory/import/file?dry_run=false');
    expect(request.options.body).toBeInstanceOf(FormData);

    await api.importInventoryFile(
      { uri: 'file:///one.xlsx', name: 'one.xlsx', mimeType: 'application/xlsx' },
      true,
    );
    request = lastRequest(fetchMock as unknown as jest.Mock);
    expectPath(request.url, '/inventory/import/file?dry_run=true');
  });

  it('does not retry dry-run imports or non-gateway errors', async () => {
    fetchMock.mockResolvedValue(response({ detail: 'bad link' }, 400));
    await expect(api.importInventoryFromLink('https://example.com/test.csv', true)).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs out remotely when a refresh token exists and always clears local secrets', async () => {
    await api.setSession('access', 'refresh');
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(api.logoutSession()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await api.getToken()).toBeNull();
    expect(await api.getRefreshToken()).toBeNull();
  });

  it('falls back to AsyncStorage on web and removes migrated native values', async () => {
    const previous = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    try {
      replaceSession();
      (AsyncStorage.getItem as jest.Mock)
        .mockResolvedValueOnce(null).mockResolvedValueOnce('web-token').mockResolvedValueOnce(null);
      expect(await api.getToken()).toBe('web-token');
      await api.setToken('new-web-token');
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        expect.stringMatching(/^vendora_credentials_session_/),
        JSON.stringify({ accessToken: 'new-web-token', refreshToken: null }),
      );
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
    }

    await api.setToken('native-token');
    expect(SecureStore.setItemAsync).toHaveBeenCalled();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('vendora_active_credentials');
  });
});
