/** In Con Mode, checkouts come back from the local journal at once and sync right after. */
const mockQueueSale = jest.fn(async (b: any) => ({ id: 'local', pending: true, body: b }));
const mockQueueOrder = jest.fn(async (b: any) => ({ order_id: 'local', pending: true, body: b }));
const mockFlush = jest.fn();
jest.mock('../services/offline', () => ({
  ...jest.requireActual('../services/offline'),
  isOnline: () => true,
  queueQuickSale: (b: any) => mockQueueSale(b),
  queueSaleOrder: (b: any) => mockQueueOrder(b),
  flushInBackground: () => mockFlush(),
}));

import * as api from '../services/api';
import { resetConModeForTests, setConMode } from '../services/conMode';
import { replaceSession } from '../services/session';

describe('con mode checkout', () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  beforeEach(() => {
    jest.clearAllMocks();
    resetConModeForTests();
    replaceSession('seller');
  });

  it('queues quick sales and orders without touching the network, then flushes', async () => {
    setConMode(true);
    const sale = await api.createTransaction({ method: 'cash', gross_amount: '10.00' } as any);
    const order = await api.createSaleOrder({ method: 'cash', lines: [{ item_id: 'a', quantity: 1, unit_price: '5.00' }] });
    expect(sale).toMatchObject({ pending: true });
    expect(order).toMatchObject({ pending: true });
    expect(mockQueueSale.mock.calls[0][0].client_request_id).toEqual(expect.any(String));
    expect(mockFlush).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
