import { buyCheck, dollars, verdictFor } from '../utils/buyCheck';

describe('verdictFor', () => {
  it('needs $10 and 30% of cost for a good buy', () => {
    expect(verdictFor(1000, 2000)).toBe('good');
    expect(verdictFor(999, 2000)).toBe('thin');
    expect(verdictFor(2900, 10000)).toBe('thin');
    expect(verdictFor(3000, 10000)).toBe('good');
    expect(verdictFor(0, 500)).toBe('pass');
    expect(verdictFor(-100, 500)).toBe('pass');
  });
});

describe('buyCheck', () => {
  const summary = { low: '20.00', median: '30.00', high: '40.00' };
  it('subtracts eBay fees and leaves profit empty without a cost', () => {
    const c = buyCheck(summary, '');
    expect(c.netMedianCents).toBe(3000 - Math.round(3000 * 0.136) - 40);
    expect(c.verdict).toBeNull();
    expect(c.profitMedianCents).toBeNull();
  });
  it('computes profit range and verdict from a cost', () => {
    const c = buyCheck(summary, '$26');
    expect(c.profitMedianCents).toBe(c.netMedianCents - 2600);
    expect(buyCheck(summary, '25').verdict).toBe('thin');
    expect(c.verdict).toBe('pass');
    expect(buyCheck(summary, '5').verdict).toBe('good');
  });
  it('ignores an invalid cost', () => {
    expect(buyCheck(summary, 'abc').verdict).toBeNull();
  });
});

it('formats whole dollars with sign', () => {
  expect(dollars(5249)).toBe('$52');
  expect(dollars(-1250)).toBe('-$13');
});
