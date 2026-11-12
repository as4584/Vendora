import { FEE_MODELS, feeModelFor, itemProfit } from '../services/profit';

const sale = (o: Record<string, unknown> = {}) => ({
  status: 'completed', is_refund: false, gross_amount: '250.00', fee_amount: '20.00', net_amount: '230.00', quantity: 1, ...o,
});

describe('realized profit (sold)', () => {
  it('uses real fees and the cost frozen on each sale', () => {
    const p = itemProfit({ buy_price: '110', expected_sell_price: '300', platform: 'eBay' }, [
      sale({ cost_amount: '110.00' }),
      sale({ gross_amount: '200.00', fee_amount: '0.00', net_amount: '200.00' }), // in person, no cost frozen
    ]);
    expect(p).toMatchObject({ kind: 'realized', revenue: 450, fees: 20, cost: 220, profit: 210, note: 'after $20 in fees', roi: 95 });
  });

  it('ignores refunds and voids, and says when no fees were recorded', () => {
    const p = itemProfit({ buy_price: '50', expected_sell_price: null, platform: null }, [
      sale({ gross_amount: '80.00', fee_amount: '0', net_amount: '80.00' }),
      sale({ is_refund: true }),
      sale({ status: 'refunded' }),
      sale({ status: 'voided' }),
    ]);
    expect(p).toMatchObject({ kind: 'realized', profit: 30, note: 'no fees recorded' });
  });

  it('counts quantity when no cost was frozen', () => {
    const p = itemProfit({ buy_price: '10', expected_sell_price: null, platform: null }, [sale({ quantity: 3, gross_amount: '60', fee_amount: '0', net_amount: '60' })]);
    expect(p.cost).toBe(30);
  });
});

describe('estimated profit (not sold)', () => {
  it('subtracts the platform fee', () => {
    // eBay sneaker over $150: 8%, no fixed fee.
    expect(itemProfit({ buy_price: '110', expected_sell_price: '200', platform: 'eBay' }, [])).toMatchObject({
      kind: 'estimate', fees: 16, profit: 74, note: 'est. after $16 eBay fees', roi: 67,
    });
    expect(itemProfit({ buy_price: '100', expected_sell_price: '200', platform: 'StockX' }).profit).toBe(76);
  });

  it('is before fees for in-person or unknown platforms, and safe with missing data', () => {
    expect(itemProfit({ buy_price: '40', expected_sell_price: '60', platform: 'In person' })).toMatchObject({ fees: 0, profit: 20, note: 'before fees' });
    expect(itemProfit({ buy_price: null, expected_sell_price: null, platform: null })).toMatchObject({ profit: 0, roi: null });
    expect(itemProfit({ buy_price: 'abc', expected_sell_price: '10', platform: 'ebay' }).cost).toBe(0);
  });
});

it('fee models', () => {
  expect(FEE_MODELS.ebay.fee(100)).toBe(14);
  expect(FEE_MODELS.goat.fee(100)).toBe(17.4);
  expect(FEE_MODELS.tcgplayer.fee(10)).toBe(1.63);
  expect(FEE_MODELS.whatnot.fee(10)).toBe(1.39);
  expect(feeModelFor('Square POS')?.label).toBe('card');
  expect(feeModelFor('Whatnot live')?.label).toBe('Whatnot');
  expect(feeModelFor('cash')).toBeNull();
  expect(feeModelFor('')).toBeNull();
});
