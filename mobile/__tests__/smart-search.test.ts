import { parseQuery, smartSearch, type Searchable } from '../services/smartSearch';

const v = (...pairs: [string, number][]) => ({ variants: pairs.map(([size, quantity]) => ({ size, quantity })) });

const STOCK: (Searchable & { id: string })[] = [
  { id: 'bc', name: "Air Jordan 4 Retro 'Black Cat'", sku: 'CU1110-010', color: 'Black', category: 'Sneakers', custom_attributes: v(['9', 1], ['10', 2]) },
  { id: 'panda', name: "Nike Dunk Low 'Panda'", sku: 'DD1391-100', color: 'White/Black', category: 'Sneakers', size: '10.5' },
  { id: 'chi', name: "Air Jordan 1 Retro High OG 'Chicago Lost & Found'", sku: 'DZ5485-612', category: 'Sneakers', custom_attributes: v(['11', 1], ['10', 0]) },
  { id: 'onyx', name: "Yeezy Boost 350 V2 'Onyx'", sku: 'HQ4540', category: 'Sneakers', size: '9' },
  { id: 'nb', name: 'New Balance 550 White Green', sku: 'BB550WT1', category: 'Sneakers', size: '10' },
  { id: 'wemby10', name: '2023 Prizm Victor Wembanyama Rookie', sku: 'PRIZM-136', category: 'Trading Cards', condition: 'PSA 10', custom_attributes: { player: 'Victor Wembanyama', year: 2023 } },
  { id: 'wembyraw', name: '2023 Prizm Victor Wembanyama Rookie', sku: 'PRIZM-136-RAW', category: 'Trading Cards', condition: 'Raw' },
  { id: 'zard', name: 'Charizard ex 199/165 Pokemon 151', sku: 'SV3PT5-199', category: 'Trading Cards', condition: 'BGS 9.5' },
];
const ids = (q: string) => smartSearch(STOCK, q).map((i) => i.id);

it.each([
  ['jordon 4 blk cat', 'bc'],
  ['aj4 black cat', 'bc'],
  ['pandas', 'panda'],
  ['dd1391', 'panda'],
  ['yzy onyx', 'onyx'],
  ['nb 550', 'nb'],
  ['wemby prizm psa 10', 'wemby10'],
  ['charizard bgs 9.5', 'zard'],
  ['CU1110-010', 'bc'],
])('"%s" finds %s first', (q, first) => {
  expect(ids(q)[0]).toBe(first);
});

it('filters sizes using in-stock variants', () => {
  expect(ids('jordan sz 10')).toEqual(['bc']);
  expect(ids('dunk size 10.5')).toEqual(['panda']);
  expect(ids('dunk 10.5')).toEqual(['panda']);
  expect(new Set(ids('sz9'))).toEqual(new Set(['bc', 'onyx']));
  expect(ids('jordan 11w')).toEqual(['chi']);
});

it('keeps grades together and requires every word', () => {
  expect(ids('wembanyama psa 10')).toEqual(['wemby10']);
  expect(ids('wembanyama raw')).toEqual(['wembyraw']);
  expect(ids('jordan onyx')).toEqual([]);
  expect(ids('zzzz')).toEqual([]);
});

it('returns everything for an empty query', () => {
  expect(smartSearch(STOCK, '')).toHaveLength(STOCK.length);
  expect(smartSearch(STOCK, null)).toHaveLength(STOCK.length);
});

it('parses seller shorthand', () => {
  const q = parseQuery('AJ1 sz 10 psa 9 blk 10w');
  expect(q.terms).toEqual(['jordan 1', 'psa 9', 'black']);
  expect([...q.sizes]).toEqual(['10']);
  expect(parseQuery('2023 prizm').looseNumbers).toEqual([]);
});

it('handles odd data safely', () => {
  const weird: Searchable[] = [{ name: null, custom_attributes: { nested: [{ deep: 'Rare Holo' }], n: 7 } }, { size: 'OS' }];
  expect(smartSearch(weird, 'holo')).toHaveLength(1);
  expect(smartSearch(weird, 'sz 10')).toEqual([]);
});
