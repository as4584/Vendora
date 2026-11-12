import { looksLikeCard, parseCardLabel } from '../services/smartScan/parseCard';
import { parseScanText } from '../services/smartScan';

describe('card and slab label reading', () => {
  it('reads a PSA slab: name, number, grade and cert', () => {
    const lines = ['2023 POKEMON SV151 EN', 'CHARIZARD ex', 'SPECIAL ILLUSTRATION RARE', '#199', 'GEM MT 10', '87654321'];
    expect(looksLikeCard(lines)).toBe(true);
    expect(parseCardLabel(lines)).toEqual({
      category: 'collectibles',
      brand: 'Pokemon',
      condition: 'PSA 10',
      sku: 'PSA-87654321',
      name: '2023 Pokemon Charizard ex #199',
    });
  });

  it('reads a raw Pokemon card by HP and set number', () => {
    const lines = ['Charizard ex', 'HP 330', 'Burning Darkness 180+', 'Weakness Resistance Retreat', '199/165', 'Illus. akagi'];
    expect(looksLikeCard(lines)).toBe(true);
    expect(parseCardLabel(lines)).toMatchObject({ name: 'Charizard ex #199', condition: 'Raw', category: 'collectibles' });
  });

  it('reads a graded sports card (BGS 9.5)', () => {
    const lines = ['BECKETT', '2018 TOPPS CHROME', 'SHOHEI OHTANI', 'RC #150', 'GEM MINT 9.5', '0012345678'];
    const f = parseCardLabel(lines);
    expect(f.condition).toBe('BGS 9.5');
    expect(f.brand).toBe('Topps');
    expect(f.name).toBe('2018 Topps Shohei Ohtani #150');
    expect(f.sku).toBe('BGS-0012345678');
  });

  it('leaves out what it cannot read', () => {
    expect(parseCardLabel(['PSA'])).toEqual({ category: 'collectibles', condition: 'PSA' });
  });

  it('routes text to the card or box reader automatically', () => {
    expect(parseScanText(['2023 POKEMON SV151 EN', 'CHARIZARD ex', 'GEM MT 10']).category).toBe('collectibles');
    const box = parseScanText(['NIKE', 'AIR JORDAN 4 RETRO', 'FV5029-006', 'US 10']);
    expect(box.category).not.toBe('collectibles');
    expect(looksLikeCard(['NIKE', 'AIR JORDAN 4 RETRO', 'FV5029-006', 'US 10'])).toBe(false);
  });
});
