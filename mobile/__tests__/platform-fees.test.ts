import { PLATFORM_FEES, estimateFeeCents } from '../utils/platformFees';

describe('estimateFeeCents', () => {
  it('applies percent plus fixed fee, rounded to cents', () => {
    expect(estimateFeeCents('ebay', 10000)).toBe(1400); // 13.6% + $0.40
    expect(estimateFeeCents('in_person', 10000)).toBe(0);
    expect(estimateFeeCents('goat', 20000)).toBe(2980); // 12.4% + $5
  });

  it('handles Poshmark flat fee and FB minimum', () => {
    expect(estimateFeeCents('poshmark', 1000)).toBe(295);
    expect(estimateFeeCents('poshmark', 5000)).toBe(1000);
    expect(estimateFeeCents('fb_shipped', 500)).toBe(80);
  });

  it('never exceeds the sale and is 0 for unknown platforms or empty sales', () => {
    expect(estimateFeeCents('goat', 300)).toBe(300);
    expect(estimateFeeCents('nope', 10000)).toBe(0);
    expect(estimateFeeCents('ebay', 0)).toBe(0);
  });

  it('has unique keys', () => {
    expect(new Set(PLATFORM_FEES.map((p) => p.key)).size).toBe(PLATFORM_FEES.length);
  });
});
