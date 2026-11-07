import { BRAND, COLORS, CONTROL } from '../theme/tokens';

function luminance(hex: string): number {
  const rgb = hex.match(/[a-f0-9]{2}/gi)!.map(channel => {
    const s = parseInt(channel, 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('Warm-light accessibility tokens', () => {
  it.each([COLORS.bg, COLORS.card, COLORS.cardAlt])('keeps body, metadata, and semantic text readable on %s', surface => {
    for (const text of [COLORS.text, COLORS.textMuted, COLORS.textSoft, COLORS.primary, COLORS.success, COLORS.warning, COLORS.danger, COLORS.info]) {
      expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it.each([COLORS.primary, BRAND.primaryPressed, COLORS.danger, BRAND.dangerPressed, COLORS.warning, COLORS.info, COLORS.success])('keeps white action and notice labels readable on %s', surface => {
    expect(contrast(BRAND.onPrimary, surface)).toBeGreaterThanOrEqual(4.5);
  });
  it('uses a light background and actual 44pt minimum controls', () => {
    expect(luminance(COLORS.bg)).toBeGreaterThan(0.8);
    expect(Math.min(...Object.values(CONTROL))).toBeGreaterThanOrEqual(44);
  });
});
