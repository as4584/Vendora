import {
  REPEAT_COOLDOWN_MS,
  addScan,
  applyCostToAll,
  missingNames,
  planSave,
  setQty,
  totalUnits,
  updateEntry,
  type TrayEntry,
} from '../services/batchScan';

const T0 = 1_000_000;
const panda = { name: 'Nike Dunk Low Panda', category: 'Sneakers', sku: 'DD1391-100', size: '10' };

it('counts the same box once per cooldown and moves it to the top', () => {
  let t: TrayEntry[] = [];
  t = addScan(t, '111', panda, true, T0).tray;
  t = addScan(t, '222', {}, false, T0 + 10).tray;
  expect(addScan(t, '111', panda, true, T0 + 100).added).toBe(false); // camera repeat
  t = addScan(t, '111', panda, true, T0 + REPEAT_COOLDOWN_MS + 1).tray;
  expect(t.map((e) => [e.barcode, e.qty])).toEqual([['111', 2], ['222', 1]]);
  expect(totalUnits(t)).toBe(3);
  expect(addScan(t, '  ', {}, false, T0).added).toBe(false);
});

it('different sizes of the same barcode stay separate lines', () => {
  let t = addScan([], '111', { ...panda, size: '9' }, true, T0).tray;
  t = addScan(t, '111', { ...panda, size: '10' }, true, T0 + 1).tray;
  expect(t).toHaveLength(2);
});

it('edits, quantities, removal and cost-for-all', () => {
  let t = addScan([], '111', panda, true, T0).tray;
  t = addScan(t, '222', { buy_price: '50' }, false, T0).tray;
  expect(missingNames(t).map((e) => e.barcode)).toEqual(['222']);
  t = updateEntry(t, t[0].key, { fields: { name: 'Mystery box' } });
  expect(missingNames(t)).toEqual([]);
  t = applyCostToAll(t, '110');
  expect(t.map((e) => e.fields.buy_price)).toEqual(['50', '110']); // keeps typed costs
  expect(applyCostToAll(t, '99', true).map((e) => e.fields.buy_price)).toEqual(['99', '99']);
  expect(applyCostToAll(t, '  ')).toBe(t);
  t = setQty(t, t[0].key, 3);
  expect(t[0].qty).toBe(3);
  t = setQty(t, t[0].key, 0);
  expect(t).toHaveLength(1);
});

it('plans creates with sizes as variants for sneakers', () => {
  const t = addScan([], '111', { ...panda, buy_price: '110' }, true, T0).tray;
  const [a] = planSave(setQty(t, t[0].key, 2));
  expect(a).toMatchObject({
    kind: 'create',
    payload: { name: 'Nike Dunk Low Panda', upc: '111', sku: 'DD1391-100', quantity: 2, buy_price: '110',
      custom_attributes: { variants: [{ size: '10', quantity: 2 }] } },
  });
  const [card] = planSave(addScan([], '333', { name: 'Wemby PSA 10', category: 'Trading Cards', size: 'OS' }, true, T0).tray);
  expect(card).toMatchObject({ kind: 'create', payload: { size: 'OS' } });
});

it('restocks existing items instead of duplicating them', () => {
  const plain = { id: 'item-1', name: 'NB 550', quantity: 2, size: '10', custom_attributes: null };
  let t = addScan([], '444', { name: 'NB 550' }, true, T0, plain).tray;
  expect(t[0].addToExisting).toBe(true);
  expect(missingNames(t)).toEqual([]);
  expect(planSave(t)[0]).toMatchObject({ kind: 'increment', itemId: 'item-1', quantity: 3, expected: 2 });

  const sized = { id: 'item-2', name: 'Panda', quantity: 3, size: null, custom_attributes: { variants: [{ size: '10', quantity: 1 }, { size: '9', quantity: 2 }] } };
  t = addScan([], '111', panda, true, T0, sized).tray;
  expect(planSave(t)[0]).toMatchObject({ kind: 'increment', quantity: 4, variants: [{ size: '10', quantity: 2 }, { size: '9', quantity: 2 }] });
  t = addScan([], '111', { ...panda, size: '12' }, true, T0, sized).tray;
  expect((planSave(t)[0] as { variants: unknown[] }).variants).toContainEqual({ size: '12', quantity: 1 });

  // Seller turns it off: becomes a new item.
  t = updateEntry(t, t[0].key, { addToExisting: false });
  expect(planSave(t)[0].kind).toBe('create');
});
