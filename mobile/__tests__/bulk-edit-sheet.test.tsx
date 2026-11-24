import { buildBulkPayload } from '../components/BulkEditSheet';

const base = { priceMode: 'percent' as const, price: '', cost: '', category: '', platform: '', status: null };

describe('buildBulkPayload', () => {
  it('requires at least one change', () => {
    expect(buildBulkPayload(base)).toBe('Change at least one field.');
  });

  it('sends only filled-in fields, trimmed and parsed', () => {
    expect(buildBulkPayload({ ...base, price: '-10%', cost: '$1,200', category: ' Cards ', status: 'listed' })).toEqual({
      list_price: { mode: 'percent', value: -10 }, buy_price: 1200, category: 'Cards', status: 'listed',
    });
  });

  it('rejects bad numbers and negative set prices or costs', () => {
    expect(buildBulkPayload({ ...base, price: 'abc' })).toBe('Enter a number for the price.');
    expect(buildBulkPayload({ ...base, priceMode: 'set', price: '-1' })).toBe("Price can't be negative.");
    expect(buildBulkPayload({ ...base, cost: '-3' })).toBe('Enter a cost of 0 or more.');
  });

  it('allows negative relative changes', () => {
    expect(buildBulkPayload({ ...base, priceMode: 'amount', price: '-5' })).toEqual({ list_price: { mode: 'amount', value: -5 } });
  });
});
