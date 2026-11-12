import { compareItems, daysInStock, staleBadge, type SortKey } from '../utils/inventorySort';
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

describe('stale stock', () => {
  it('counts whole days for available items only', () => {
    expect(daysInStock(item('a', { created_at: daysAgo(45) }), NOW)).toBe(45);
    expect(daysInStock(item('b', { status: 'sold', created_at: daysAgo(45) }), NOW)).toBeNull();
    expect(daysInStock(item('c', { quantity: 0, created_at: daysAgo(45) }), NOW)).toBeNull();
  });

  it('badges at 30 days (amber) and 90 days (red), not before', () => {
    expect(staleBadge(item('a', { created_at: daysAgo(29) }), NOW)).toBeNull();
    expect(staleBadge(item('a', { created_at: daysAgo(30) }), NOW)).toEqual({ label: '30d in stock', tone: 'warning' });
    expect(staleBadge(item('a', { created_at: daysAgo(120) }), NOW)).toEqual({ label: '120d in stock', tone: 'danger' });
  });
});
