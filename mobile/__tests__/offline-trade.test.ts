/** A trade made offline is one outbox entry: given pairs leave stock now and come back if rejected. */
let AsyncStorage: any;
const JOURNAL_KEY = 'account:v1:seller:offline:journal';
async function read(key: string) {
  return JSON.parse((await AsyncStorage.getItem(JOURNAL_KEY)) ?? 'null')?.[key] ?? null;
}
async function seed(patch: Record<string, unknown>) {
  await AsyncStorage.setItem(JOURNAL_KEY, JSON.stringify({
    mirror: {}, outbox: [], remap: {}, pendingInvoices: [], failed: [], lastSync: null, ...patch,
  }));
}

describe('offline trades', () => {
  beforeEach(async () => {
    jest.resetModules();
    AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.clear();
    require('../services/session').replaceSession('seller');
  });

  it('queues the trade and takes the given pair out of stock', async () => {
    await seed({ mirror: { a: { id: 'a', quantity: 1, status: 'in_stock' } } });
    const offline = require('../services/offline/inventory');
    const trade = await offline.queueTrade({
      give: [{ item_id: 'a', value: '250.00' }], get: [{ name: '11s', value: '220.00' }],
      cash_amount: '30.00', cash_method: 'cash',
    });
    expect(trade).toMatchObject({ pending: true, value_out: '250.00', value_in: '220.00', cash_amount: '30.00', cash_method: 'cash' });
    const outbox = await read('outbox');
    expect(outbox[0]).toMatchObject({ kind: 'trade', path: '/trades', method: 'POST' });
    expect(outbox[0].body.client_request_id).toBe(outbox[0].id);
    expect(await offline.offlineGetItem('a')).toMatchObject({ quantity: 0, status: 'sold' });
  });

  it('follows offline-created ids and restores stock when rejected', async () => {
    await seed({
      mirror: { b: { id: 'b', quantity: 2, status: 'in_stock' } },
      remap: { local_1: 'srv_1' },
      outbox: [{ id: 'ob_t', kind: 'trade', path: '/trades', method: 'POST', createdAt: 't', attempts: 0,
        body: { give: [{ item_id: 'local_1', value: '5.00' }, { item_id: 'b', quantity: 2, value: '5.00' }], get: [], cash_amount: '15.00' } }],
    });
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('Only 1 unit(s) available.'), { status: 409 }));
    require('../services/offline/sender').setSender(send);
    const offline = require('../services/offline/inventory');
    expect((await offline.offlineGetItem('b')).quantity).toBe(0);
    await offline.flushOutbox();
    expect(send).toHaveBeenCalledWith('/trades', 'POST', expect.objectContaining({
      give: [{ item_id: 'srv_1', value: '5.00' }, { item_id: 'b', quantity: 2, value: '5.00' }],
    }), expect.anything());
    expect((await read('mirror')).b).toMatchObject({ quantity: 2 });
    expect((await read('failed'))[0]).toMatchObject({ id: 'ob_t', kind: 'trade' });
  });
});
