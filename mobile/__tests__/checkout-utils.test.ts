import {
  allocateCents,
  buildReceiptText,
  centsToString,
  computeCheckout,
  formatCents,
  parseScaled,
  paymentLabel,
  sameBarcode,
  sizeOptions,
  toCents,
  toSignedCents,
} from '../utils/checkout';
import { canUndoSale, haggle } from '../utils/checkout';

describe('checkout cents math', () => {
  it('parses typed money without floats', () => {
    expect(toCents('19.99')).toBe(1999);
    expect(toCents('19,9')).toBe(1990);
    expect(toCents('.5')).toBe(50);
    expect(toCents('0.105')).toBe(11); // half up
    expect(toCents('')).toBe(0);
    expect(toCents('abc')).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(toCents(12)).toBe(1200);
    expect(parseScaled('.', 2)).toBeNull();
    expect(parseScaled('9'.repeat(20), 2)).toBeNull();
    expect(toSignedCents('-12.50')).toBe(-1250);
    expect(toSignedCents(undefined)).toBe(0);
  });

  it('formats cents', () => {
    expect(centsToString(5)).toBe('0.05');
    expect(centsToString(-1250)).toBe('-12.50');
    expect(formatCents(123456)).toBe('$1234.56');
    expect(formatCents(-5)).toBe('-$0.05');
  });

  it('allocates exactly and skips zero-weight lines', () => {
    const parts = allocateCents(1000, [3333, 3333, 3334, 0]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(parts[3]).toBe(0);
    expect(allocateCents(0, [1, 2])).toEqual([0, 0]);
    expect(allocateCents(5, [0, 0])).toEqual([0, 0]);
  });

  it('matches the server: percent discount, then tax on the discounted subtotal', () => {
    const t = computeCheckout({
      lines: [{ priceCents: 3333, qty: 3 }],
      discountMode: 'percent',
      discountValue: '15',
      taxRate: '6.625',
    });
    expect(t).toMatchObject({ subtotal: 9999, discount: 1500, gross: 8499, tax: 563, total: 9062, error: null });
  });

  it('flags bad discounts and tax', () => {
    const base = { lines: [{ priceCents: 1000, qty: 1 }], taxRate: '' };
    expect(computeCheckout({ ...base, discountMode: 'amount', discountValue: '10.01' }).error).toMatch(/more than the subtotal/);
    expect(computeCheckout({ ...base, discountMode: 'amount', discountValue: 'x' }).error).toMatch(/number/);
    expect(computeCheckout({ ...base, discountMode: 'percent', discountValue: 'x' }).error).toMatch(/number/);
    expect(computeCheckout({ ...base, discountMode: 'percent', discountValue: '101' }).error).toMatch(/100%/);
    expect(computeCheckout({ ...base, discountMode: 'amount', discountValue: '', taxRate: '31' }).error).toMatch(/30%/);
    const ok = computeCheckout({ ...base, discountMode: 'amount', discountValue: '10' });
    expect(ok).toMatchObject({ gross: 0, total: 0, error: null });
  });

  it('builds a text receipt', () => {
    const text = buildReceiptText({
      businessName: '', date: new Date('2026-11-02T15:00:00Z'),
      lines: [{ name: 'Dunk', size: '10', qty: 2, unitCents: 10000 }, { name: 'Tee', qty: 1, unitCents: 2000 }],
      subtotal: 22000, discount: 2000, tax: 1000, taxRate: '5', total: 21000,
      payments: [{ method: 'cash', cents: 15000 }, { method: 'card', cents: 6000 }], pending: true,
    });
    expect(text).toContain('Receipt');
    expect(text).toContain('Dunk (Size 10)');
    expect(text).toContain('2 x $100.00  $200.00');
    expect(text).toContain('Discount  -$20.00');
    expect(text).toContain('Tax (5%)  $10.00');
    expect(text).toContain('Paid Card  $60.00');
    expect(text).toContain('Recorded offline');
    const plain = buildReceiptText({
      date: new Date(), lines: [], subtotal: 0, discount: 0, tax: 0, total: 0, payments: [],
    });
    expect(plain).not.toContain('Discount');
    expect(plain).not.toContain('Tax');
  });

  it('reads size variants and compares barcodes', () => {
    expect(sizeOptions({ custom_attributes: { variants: [{ size: ' 9 ', quantity: '2' }, { size: '', quantity: 1 }, { quantity: 1 }, { size: '10', quantity: -1 }] } }))
      .toEqual([{ size: '9', quantity: 2 }, { size: '10', quantity: 0 }]);
    expect(sizeOptions({ custom_attributes: null })).toEqual([]);
    expect(sameBarcode('012345678905', '12345678905')).toBe(true);
    expect(sameBarcode('000', '0')).toBe(false);
    expect(sameBarcode(null, '1')).toBe(false);
    expect(paymentLabel('cashapp')).toBe('Cash App');
    expect(paymentLabel('weird')).toBe('weird');
  });
});

describe('haggle', () => {
  it('knocks off fixed amounts, 10% rounded to whole dollars, or resets to list', () => {
    expect(haggle('150.00', '150.00', 'minus5')).toBe('145.00');
    expect(haggle('150.00', '150.00', 'minus10')).toBe('140.00');
    expect(haggle('155.00', '160.00', 'minus10pct')).toBe('140.00');
    expect(haggle('120.00', '160.00', 'list')).toBe('160.00');
    expect(haggle('3.00', '10.00', 'minus5')).toBe('0.00');
  });
});

it('canUndoSale requires a synced cash sale with lines', () => {
  const base = { date: new Date(), lines: [], subtotal: 0, discount: 0, tax: 0, total: 0, payments: [{ method: 'cash', cents: 1 }], orderId: 'o', transactionIds: ['t'] };
  expect(canUndoSale(base)).toBe(true);
  expect(canUndoSale(null)).toBe(false);
  expect(canUndoSale({ ...base, transactionIds: [] })).toBe(false);
  expect(canUndoSale({ ...base, payments: [{ method: 'cash', cents: 1 }, { method: 'card', cents: 1 }] })).toBe(false);
});
