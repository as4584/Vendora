import {
  formatCompactDate,
  formatCurrency,
  resolveQty,
  resolvedPhoto,
  sizeBreakdown,
} from '../utils/inventory';

describe('inventory formatting utilities', () => {
  it('formats invalid, missing, and numeric currency values', () => {
    expect(formatCurrency(null)).toBe('—');
    expect(formatCurrency('not-a-number')).toBe('—');
    expect(formatCurrency('12.5')).toBe('$12.50');
  });

  it('formats missing, invalid, and valid dates', () => {
    expect(formatCompactDate(null)).toBe('Never');
    expect(formatCompactDate('not-a-date')).toBe('Unknown');
    expect(formatCompactDate('2026-01-02T00:00:00Z')).toBeTruthy();
  });

  it('resolves photos, quantities, and size descriptions', () => {
    const item = {
      quantity: 7,
      size: 'M',
      photo_front_url: 'front-url',
      photo_back_url: null,
      custom_attributes: null,
    } as any;
    expect(resolveQty(item)).toBe(7);
    expect(resolvedPhoto(item, 'front')).toBe('front-url');
    expect(resolvedPhoto(item, 'back')).toBeNull();
    expect(sizeBreakdown(item)).toBe('M (7)');

    const variants = {
      ...item,
      photo_front_url: null,
      custom_attributes: {
        photo_front: 'front-custom',
        photo_back: 'back-custom',
        variants: [
          { size: 'S', quantity: 1 },
          { size: 'M', quantity: 2 },
        ],
      },
    };
    expect(resolveQty(variants)).toBe(3);
    expect(resolvedPhoto(variants, 'front')).toBe('front-custom');
    expect(resolvedPhoto(variants, 'back')).toBe('back-custom');
    expect(sizeBreakdown(variants)).toContain('S (1)');
  });
});
