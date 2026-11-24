import { applyRule, cleanCode, ruleMatches, SCANNER_BARCODE_TYPES, suggestRule } from '../utils/barcodeRules';
import { sameSku } from '../utils/checkout';

describe('barcode rules (device mirror of the server engine)', () => {
  it('reads every symbology stores print', () => {
    for (const t of ['codabar', 'itf14', 'code93', 'datamatrix', 'pdf417', 'aztec', 'qr']) {
      expect(SCANNER_BARCODE_TYPES).toContain(t);
    }
  });

  it('cleans scanner noise', () => {
    expect(cleanCode(' ab c\n\u0007')).toBe('ABC');
  });

  it('strips prefix and suffix then slices', () => {
    const rule = { prefix: 'sk', suffix: '/a', slice_start: 1, slice_length: 5 };
    expect(applyRule(rule, 'SK1234599/A')).toBe('12345');
    expect(applyRule({ ...rule, strip_prefix: false, slice_start: null, slice_length: null }, 'SK12/A')).toBe('SK12');
    expect(applyRule({ ...rule, strip_suffix: false, slice_start: null, slice_length: null }, 'SK12/A')).toBe('12/A');
    expect(applyRule({ prefix: 'X', slice_length: 2 }, 'XABCD')).toBe('AB');
    expect(applyRule({ prefix: 'X', slice_start: 3 }, 'XABCD')).toBe('CD');
    expect(applyRule({ prefix: 'X' }, 'X')).toBeNull();
  });

  it('only applies rules whose conditions match', () => {
    expect(ruleMatches({}, 'ABC')).toBe(false);
    expect(ruleMatches({ prefix: 'A', enabled: false }, 'ABC')).toBe(false);
    expect(ruleMatches({ prefix: 'Z' }, 'ABC')).toBe(false);
    expect(ruleMatches({ suffix: 'Z' }, 'ABC')).toBe(false);
    expect(ruleMatches({ min_length: 4 }, 'ABC')).toBe(false);
    expect(ruleMatches({ max_length: 2 }, 'ABC')).toBe(false);
    expect(ruleMatches({ min_length: 3, max_length: 3 }, 'ABC')).toBe(true);
    expect(applyRule({ prefix: 'Z' }, 'ABC')).toBeNull();
  });

  it('suggests a rule from one sample', () => {
    expect(suggestRule('STR-00123')).toEqual({ name: 'Codes starting STR-', prefix: 'STR-', strip_prefix: true });
    expect(suggestRule('0012345')).toEqual({ name: '7-character codes', min_length: 7, max_length: 7 });
    expect(suggestRule('ABC').min_length).toBe(3);
  });

  it('matches SKU stickers ignoring case and spaces', () => {
    expect(sameSku('AJ1 001', 'aj1001')).toBe(true);
    expect(sameSku(null, 'x')).toBe(false);
    expect(sameSku(' ', ' ')).toBe(false);
    expect(sameSku('A', 'B')).toBe(false);
  });
});
