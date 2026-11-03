/**
 * Turns the text lines read off a box label into item fields.
 * Pure and offline. Tuned for sneaker/apparel box labels, safe on anything:
 * if a field isn't confidently found it is simply left out.
 */
export type ScanFields = {
  name?: string;
  brand?: string;
  category?: string;
  sku?: string;
  style_code?: string;
  size?: string;
  color?: string;
  condition?: string;
  buy_price?: string;
  expected_sell_price?: string;
  platform?: string;
};

const BRANDS: [RegExp, string][] = [
  [/\bJORDAN\b|\bJUMPMAN\b/i, "Jordan"],
  [/\bNIKE\b/i, "Nike"],
  [/\bYEEZY\b/i, "Yeezy"],
  [/\bADIDAS\b/i, "adidas"],
  [/\bNEW\s*BALANCE\b/i, "New Balance"],
  [/\bASICS\b/i, "ASICS"],
  [/\bPUMA\b/i, "Puma"],
  [/\bCONVERSE\b/i, "Converse"],
  [/\bVANS\b/i, "Vans"],
  [/\bREEBOK\b/i, "Reebok"],
  [/\bSAUCONY\b/i, "Saucony"],
  [/\bHOKA\b/i, "HOKA"],
  [/\bON\s+RUNNING\b/i, "On"],
];

// Ordered most specific first.
const STYLE_PATTERNS: RegExp[] = [
  /\b([A-Z]{2}\d{4})[\s-](\d{3})\b/, // Nike / Jordan: DD1391-100, CW2288 111
  /\b(\d{6})[\s-](\d{3})\b/,         // older Nike: 555088-134
  /\bART\.?\s*(?:NO\.?)?\s*([A-Z]{2}\d{4}|[A-Z]\d{5})\b/i, // adidas "ART. GW2871" / "ART. B75806"
  /\b([UMWB][A-Z]?\d{3,4}[A-Z]{2,3}\d?)\b/,       // New Balance: U9060AAA, M990GL6
];

const ADIDAS_STYLE = /\b([A-Z]{2}\d{4}|[A-Z]\d{5})\b/;

const SIZE_PATTERNS: RegExp[] = [
  /\bUS\s*(?:MEN'?S|WOMEN'?S|M|W)?\s*(\d{1,2}(?:\.5)?\s?[YC]?)\b/i,
  /\b(\d{1,2}(?:\.5)?\s?[YC]?)\s*US\b/i,
  /\bSIZE\s*:?\s*(\d{1,2}(?:\.5)?\s?[YC]?)\b/i,
];

const COLORWAY = /^[A-Z][A-Z .'&]*\/[A-Z .'\/&-]+$/;
const NOISE = /\b(UPC|EAN|MADE IN|FABRIQU|HECHO|UK\b|EUR\b|CM\b|JP\b|CN\b|BR\b|MEX\b|STYLE|ART\b|PO\b|LOT\b)/i;

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bIi\b/g, "II")
    .replace(/\bIii\b/g, "III")
    .replace(/\b(Og|Sb|Gs|Ps|Td|Se|Qs|Sp|Nrg|Prm|Lx)\b/g, (m) => m.toUpperCase())
    .trim();
}

function findStyle(text: string, brand?: string): string | undefined {
  for (const re of STYLE_PATTERNS) {
    const m = text.match(re);
    if (m) return (m[2] ? `${m[1]}-${m[2]}` : m[1]).toUpperCase();
  }
  if (brand === "adidas" || brand === "Yeezy") {
    const m = text.match(ADIDAS_STYLE);
    if (m) return m[1].toUpperCase();
  }
  return undefined;
}

function findSize(lines: string[]): string | undefined {
  for (const re of SIZE_PATTERNS) {
    for (const line of lines) {
      const m = line.match(re);
      if (m) return m[1].replace(/\s+/g, "").toUpperCase();
    }
  }
  return undefined;
}

function looksLikeName(line: string): boolean {
  const letters = (line.match(/[A-Za-z]/g) ?? []).length;
  const digits = (line.match(/\d/g) ?? []).length;
  return letters >= 5 && digits <= letters / 3 && !NOISE.test(line) && !COLORWAY.test(line.toUpperCase());
}

export function parseBoxLabel(rawLines: string[]): ScanFields {
  const lines = rawLines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (lines.length === 0) return {};
  const text = lines.join("\n");
  const out: ScanFields = {};

  const brandHit = BRANDS.find(([re]) => re.test(text));
  if (brandHit) out.brand = brandHit[1];

  const style = findStyle(text, out.brand);
  if (style) {
    out.style_code = style;
    out.sku = style;
  }

  const size = findSize(lines);
  if (size) out.size = size;

  const color = lines.find((l) => COLORWAY.test(l.toUpperCase()) && l.length <= 60);
  if (color) out.color = titleCase(color).replace(/\s*\/\s*/g, "/");

  // Name: prefer a line naming the brand or a known model word, else the longest wordy line.
  const candidates = lines.filter(looksLikeName);
  const modelWord = /\b(AIR|DUNK|JORDAN|MAX|FORCE|YEEZY|BOOST|SAMBA|GAZELLE|CAMPUS|SPEZIAL|990|550|2002R|9060|GEL|KAYANO|CHUCK|OLD SKOOL|SLIDE|FOAM)\b/i;
  const named =
    candidates.find((l) => modelWord.test(l)) ??
    candidates.find((l) => brandHit && brandHit[0].test(l) && l.split(" ").length > 1) ??
    [...candidates].sort((a, b) => b.length - a.length)[0];
  if (named) {
    let name = titleCase(named);
    if (out.brand && !name.toLowerCase().includes(out.brand.toLowerCase())) {
      name = `${out.brand} ${name}`;
    }
    out.name = name.slice(0, 120);
  }

  if (out.brand && out.size) out.category = "Sneakers";
  return out;
}
