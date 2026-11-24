import { cashLabel, splitBasis, summarizeTrade } from '../utils/trade';

describe('trade math', () => {
  it('suggests the balancing cash and computes basis and profit', () => {
    const s = summarizeTrade([{ value: '250', cost: '150' }], [{ value: '220' }], 3000);
    expect(s).toEqual({ outCents: 25000, inCents: 22000, suggestedCashCents: 3000, basisCents: 22000, profitCents: 10000, error: null });
  });
  it('counts quantity and leaves profit unknown without a cost', () => {
    const s = summarizeTrade([{ value: '10', quantity: 2, cost: null }, { value: '5', cost: '1' }], [], 2500);
    expect(s.outCents).toBe(2500);
    expect(s.profitCents).toBeNull();
    expect(s.error).toBeNull();
    expect(summarizeTrade([{ value: '10', cost: '' }], [], 1000).profitCents).toBeNull();
  });
  it('explains trades that cannot balance', () => {
    expect(summarizeTrade([], [], 0).error).toMatch(/Add a pair/);
    expect(summarizeTrade([{ value: '100' }], [], 9000).error).toMatch(/cash must equal/);
    expect(summarizeTrade([{ value: '100' }], [{ value: '50' }], 15000).error).toMatch(/more than your pairs/);
    expect(summarizeTrade([], [{ value: '90' }], -7000)).toMatchObject({ basisCents: 7000, error: null });
  });
  it('splits basis by value, evenly when unvalued, remainder on the last valued pair', () => {
    expect(splitBasis(20000, ['150', '150'])).toEqual([10000, 10000]);
    expect(splitBasis(10000, ['1', '1', '1'])).toEqual([3333, 3333, 3334]);
    expect(splitBasis(9000, ['0', '0'])).toEqual([4500, 4500]);
    expect(splitBasis(100, ['5', '0'])).toEqual([100, 0]);
    expect(splitBasis(100, [])).toEqual([]);
  });
  it('labels the cash direction', () => {
    expect(cashLabel(3000)).toBe('They pay you $30.00');
    expect(cashLabel(-4050)).toBe('You pay $40.50');
    expect(cashLabel(0)).toBe('Even swap');
  });
});
