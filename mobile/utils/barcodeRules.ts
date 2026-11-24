/**
 * Barcode control on the device: every symbology stores print, and a local
 * mirror of the server's rule engine so the rules screen can preview a rule
 * against a sample scan before saving it.
 */

/** Everything expo-camera can read: store tags use far more than UPC/EAN. */
export const SCANNER_BARCODE_TYPES = [
  "ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "code93",
  "codabar", "itf14", "qr", "datamatrix", "pdf417", "aztec",
] as const;

export type LookupField = "auto" | "sku" | "upc" | "linked";

export interface RuleShape {
  prefix?: string | null;
  suffix?: string | null;
  min_length?: number | null;
  max_length?: number | null;
  strip_prefix?: boolean;
  strip_suffix?: boolean;
  slice_start?: number | null;
  slice_length?: number | null;
  enabled?: boolean;
}

export const LOOKUP_LABELS: Record<LookupField, string> = {
  auto: "Anything",
  sku: "SKU",
  upc: "UPC",
  linked: "Linked barcode",
};

export function cleanCode(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/[^\x20-\x7E]/g, "").toUpperCase().slice(0, 64);
}

export function ruleMatches(rule: RuleShape, raw: string): boolean {
  const code = cleanCode(raw);
  if (rule.enabled === false) return false;
  const prefix = rule.prefix ? cleanCode(rule.prefix) : "";
  const suffix = rule.suffix ? cleanCode(rule.suffix) : "";
  if (!prefix && !suffix && !rule.min_length && !rule.max_length) return false;
  if (prefix && !code.startsWith(prefix)) return false;
  if (suffix && !code.endsWith(suffix)) return false;
  if (rule.min_length && code.length < rule.min_length) return false;
  if (rule.max_length && code.length > rule.max_length) return false;
  return true;
}

/** The code a matching rule will look up, or null when the rule doesn't apply. */
export function applyRule(rule: RuleShape, raw: string): string | null {
  if (!ruleMatches(rule, raw)) return null;
  let out = cleanCode(raw);
  const prefix = rule.prefix ? cleanCode(rule.prefix) : "";
  const suffix = rule.suffix ? cleanCode(rule.suffix) : "";
  if (prefix && rule.strip_prefix !== false) out = out.slice(prefix.length);
  if (suffix && rule.strip_suffix !== false && out.endsWith(suffix)) out = out.slice(0, out.length - suffix.length);
  if (rule.slice_start) {
    const start = rule.slice_start - 1;
    out = rule.slice_length ? out.slice(start, start + rule.slice_length) : out.slice(start);
  } else if (rule.slice_length) {
    out = out.slice(0, rule.slice_length);
  }
  return out || null;
}

/** Guess a starting rule from one sample: letters up front become the prefix. */
export function suggestRule(sample: string): RuleShape & { name: string } {
  const code = cleanCode(sample);
  const lead = /^[A-Z]+[-_:/]?/.exec(code)?.[0] ?? "";
  if (lead && lead.length < code.length) {
    return { name: `Codes starting ${lead}`, prefix: lead, strip_prefix: true };
  }
  return { name: `${code.length}-character codes`, min_length: code.length, max_length: code.length };
}
