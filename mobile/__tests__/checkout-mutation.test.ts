/**
 * Tests written from Stryker's surviving mutants on utils/checkout.ts: each
 * pins an exact behavior that a subtly wrong version of the code would break.
 */
import {
  allocateCents, autoBalance, buildReceiptText, buildShowSummaryText, canUndoSale, computeCheckout,
  parseScaled, sameBarcode, sizeOptions, toCents, toSignedCents, PAYMENT_LABELS,
} from '../utils/checkout';

describe('money parsing edge cases', () => {
  it('trims, accepts a comma decimal, and rejects junk around numbers', () => {
    expect(toCents('  12.50  ')).toBe(1250);
    expect(toCents('12,5')).toBe(1250);
    expect(toCents('$12')).toBe(0);
    expect(toCents('12abc')).toBe(0);
    expect(toCents('x12')).toBe(0);
    expect(toCents('.')).toBe(0);
    expect(toCents('   ')).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(parseScaled('', 2)).toBeNull();
    expect(parseScaled(null, 2)).toBeNull();
  });
  it('handles a missing whole part, missing fraction and half-up rounding', () => {
    expect(toCents('.5')).toBe(50);
    expect(toCents('7.')).toBe(700);
    expect(toCents('7')).toBe(700);
    expect(toCents('0.004')).toBe(0);
    expect(toCents('0.005')).toBe(1);
    expect(toCents('1.994')).toBe(199);
    expect(toCents('1.995')).toBe(200);
    expect(toCents(3)).toBe(300);
  });
  it('reads signed amounts', () => {
    expect(toSignedCents(' -12.50 ')).toBe(-1250);
    expect(toSignedCents('4')).toBe(400);
    expect(toSignedCents(null)).toBe(0);
  });
});

describe('allocation', () => {
  it('splits by weight, puts the remainder on the last weighted line, sums exactly', () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([33, 33, 34]);
    expect(allocateCents(100, [1, 2, 0])).toEqual([33, 67, 0]);
    expect(allocateCents(100, [0, 0])).toEqual([0, 0]);
    expect(allocateCents(0, [5, 5])).toEqual([0, 0]);
    expect(allocateCents(1000, [300, 700])).toEqual([300, 700]);
    expect(allocateCents(10, [3])).toEqual([10]);
  });
});

describe('checkout validation boundaries', () => {
  const lines = [{ priceCents: 10000, qty: 1 }];
  it('allows exactly 100% off and exactly 30% tax', () => {
    expect(computeCheckout({ lines, discountMode: 'percent', discountValue: '100', taxRate: '' })).toMatchObject({ discount: 10000, error: null });
    expect(computeCheckout({ lines, discountMode: 'percent', discountValue: '100.01', taxRate: '' }).error).toMatch(/100%/);
    expect(computeCheckout({ lines, discountMode: 'amount', discountValue: '', taxRate: '30' })).toMatchObject({ tax: 3000, error: null });
    expect(computeCheckout({ lines, discountMode: 'amount', discountValue: '', taxRate: '30.001' }).error).toMatch(/30%/);
  });
  it('treats a blank or spaces-only discount as none, junk as an error that zeroes it', () => {
    expect(computeCheckout({ lines, discountMode: 'percent', discountValue: '  ', taxRate: '' })).toMatchObject({ discount: 0, error: null });
    expect(computeCheckout({ lines, discountMode: 'amount', discountValue: '  ', taxRate: '' })).toMatchObject({ discount: 0, error: null });
    expect(computeCheckout({ lines, discountMode: 'amount', discountValue: 'ten', taxRate: '' })).toMatchObject({ discount: 0, tax: 0, error: 'Enter the discount as a number.' });
    expect(computeCheckout({ lines, discountMode: 'percent', discountValue: 'ten', taxRate: '' }).error).toBe('Enter the discount as a number.');
    expect(computeCheckout({ lines, discountMode: 'amount', discountValue: '150', taxRate: '10' })).toMatchObject({ discount: 0, tax: 0, total: 10000 });
  });
});

describe('receipt and summary text', () => {
  const base = {
    businessName: '  Kicks Co  ', date: new Date(0), orderId: 'o', transactionIds: ['t'], pending: false,
    lines: [{ name: 'Dunk', size: '10', qty: 2, unitCents: 5000 }, { name: 'Tee', size: null, qty: 1, unitCents: 2000 }],
    subtotal: 12000, discount: 0, tax: 0, taxRate: '', total: 12000, payments: [{ method: 'cash', cents: 12000 }],
  } as any;
  it('prints every line exactly', () => {
    const text = buildReceiptText(base).split('\n');
    expect(text[0]).toBe('Kicks Co');
    expect(text[2]).toBe('');
    expect(text.slice(3)).toEqual([
      'Dunk (Size 10)', '  2 x $50.00  $100.00', 'Tee', '  $20.00  $20.00', '',
      'Subtotal  $120.00', 'Total  $120.00', 'Paid Cash  $120.00', '', 'Thank you!',
    ]);
    const extras = buildReceiptText({ ...base, businessName: ' ', discount: 500, tax: 700, taxRate: '6.625', pending: true });
    expect(extras.split('\n')[0]).toBe('Receipt');
    expect(extras).toContain('Discount  -$5.00\nTax (6.625%)  $7.00');
    expect(extras).toContain('\n\nRecorded offline; syncs when back online.\n\nThank you!');
    expect(buildReceiptText({ ...base, tax: 100, taxRate: '' })).toContain('Tax  $1.00');
  });
  it('only offers undo for synced, all-cash sales', () => {
    expect(canUndoSale(base)).toBe(true);
    expect(canUndoSale({ ...base, transactionIds: undefined })).toBe(false);
    expect(canUndoSale({ ...base, transactionIds: [] })).toBe(false);
    expect(canUndoSale(null)).toBe(false);
  });
  it('builds the show summary line by line', () => {
    const s = {
      orders: 3, units_sold: 4, subtotal: '300.00', discounts: '0.00', net_sales: '300.00', refund_count: 0,
      refunds: '0.00', fees: '5.00', cost_of_goods: '150.00', profit: '145.00', tax_collected: '0.00',
      sales_missing_cost: 0, payments: [{ method: 'zelle', net: '300.00' }], collected: '300.00', top_items: [],
    } as any;
    expect(buildShowSummaryText(s, 'Show').split('\n')).toEqual([
      'Show', '', 'Orders  3', 'Units sold  4', 'Sales  $300.00', 'Net sales  $300.00', 'Fees  -$5.00',
      'Cost of goods  -$150.00', 'Profit  $145.00', 'Sales tax collected  $0.00', '', 'Money by payment',
      'Zelle  $300.00', 'Total taken in  $300.00',
    ]);
    const full = buildShowSummaryText({ ...s, discounts: '10.00', refund_count: 1, refunds: '20.00', sales_missing_cost: 2,
      top_items: [{ name: 'Dunk', units: 2, revenue: '200.00' }] }, 'Show');
    expect(full).toContain('Discounts  -$10.00');
    expect(full).toContain('Refunds (1)  -$20.00');
    expect(full).toContain('(2 sale(s) had no cost recorded)');
    expect(full).toContain('\n\nTop items\nDunk  2 sold · $200.00');
  });
  it('labels every payment method', () => {
    expect(PAYMENT_LABELS).toMatchObject({ zelle: 'Zelle', stripe: 'Stripe', other: 'Other', split: 'Split' });
  });
});

describe('small helpers', () => {
  it('trims sizes and tolerates missing variant fields', () => {
    expect(sizeOptions({ custom_attributes: { variants: [{ size: ' 10 ', quantity: '2' }, null, { quantity: -1 }] } }))
      .toEqual(expect.arrayContaining([{ size: '10', quantity: 2 }]));
  });
  it('matches barcodes ignoring spaces and leading zeros only', () => {
    expect(sameBarcode(' 0123 ', '123')).toBe(true);
    expect(sameBarcode('000', '0')).toBe(false);
    expect(sameBarcode('1230', '123')).toBe(false);
  });
  it('auto-balances only the other row, and only when the edited row exists', () => {
    const rows = [{ key: 'a', amount: '30' }, { key: 'b', amount: '' }];
    expect(autoBalance(rows, 'a', 10000)).toEqual([{ key: 'a', amount: '30' }, { key: 'b', amount: '70.00' }]);
    expect(autoBalance(rows, 'zz', 10000)).toBe(rows);
  });
});
