import { compareItems, type SortKey } from '../utils/inventorySort';
import type { InventoryItem } from '../services/api';

const NOW = new Date('2026-11-12T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const item = (id: string, over: Partial<InventoryItem>): InventoryItem =>
  ({ id, name: id, status: 'in_stock', quantity: 1, buy_price: null, expected_sell_price: null, created_at: daysAgo(1), ...over }) as InventoryItem;

const ITEMS = [
  item('Bravo', { buy_price: '100', expected_sell_price: '150', quantity: 1, created_at: daysAgo(10) }),
  item('alpha', { buy_price: '40', expected_sell_price: '300', quantity: 5, created_at: daysAgo(40) }),
  item('Charlie', { buy_price: '200', expected_sell_price: '210', quantity: 2, created_at: daysAgo(1) }),
  item('Delta', { buy_price: '50', expected_sell_price: null, quantity: 3, created_at: daysAgo(90) }),
];

// Same expectations as backend/tests/test_inventory_sort.py, so offline order matches the server.
it.each<[SortKey, string[]]>([
  ['newest', ['Charlie', 'Bravo', 'alpha', 'Delta']],
  ['oldest', ['Delta', 'alpha', 'Bravo', 'Charlie']],
  ['price_high', ['alpha', 'Charlie', 'Bravo', 'Delta']],
  ['price_low', ['Bravo', 'Charlie', 'alpha', 'Delta']],
  ['profit', ['alpha', 'Bravo', 'Charlie', 'Delta']],
  ['qty', ['alpha', 'Delta', 'Charlie', 'Bravo']],
  ['name', ['alpha', 'Bravo', 'Charlie', 'Delta']],
])('sort %s', (sort, expected) => {
  expect([...ITEMS].sort(compareItems(sort)).map((i) => i.name)).toEqual(expected);
});

import { didYouMean } from '../services/smartSearch';

describe('did you mean', () => {
  const items = [
    { id: '1', name: 'Jordan 4 Retro Bred', sku: 'FV5029-006' },
    { id: '2', name: 'Pokemon 151 Booster Bundle', sku: null },
  ] as never[];
  it('suggests the closest item for a badly typed search', () => {
    expect((didYouMean(items, 'jordn bredd') as { name: string } | null)?.name).toBe('Jordan 4 Retro Bred');
    expect((didYouMean(items, 'pokmon bundel') as { name: string } | null)?.name).toBe('Pokemon 151 Booster Bundle');
  });
  it('stays quiet when nothing is close', () => {
    expect(didYouMean(items, 'yeezy foam')).toBeNull();
    expect(didYouMean(items, '')).toBeNull();
  });
});
