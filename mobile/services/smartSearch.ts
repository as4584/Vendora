/**
 * On-device twin of backend app/services/smart_search.py, so search works the same
 * offline (at a show with no signal). Keep the two in step.
 */
export interface Searchable {
  name?: string | null;
  sku?: string | null;
  upc?: string | null;
  color?: string | null;
  category?: string | null;
  condition?: string | null;
  size?: string | null;
  platform?: string | null;
  notes?: string | null;
  vendor_name?: string | null;
  custom_attributes?: unknown;
}

const GRADERS = new Set(["psa", "bgs", "cgc", "sgc", "tag", "beckett"]);
const NICKNAMES: Record<string, string[]> = {
  aj: ["jordan"], aj1: ["jordan 1"], aj3: ["jordan 3"], aj4: ["jordan 4"], aj11: ["jordan 11"],
  j1: ["jordan 1"], j4: ["jordan 4"], j11: ["jordan 11"], jordans: ["jordan"], dunks: ["dunk"],
  pandas: ["panda"], yzy: ["yeezy"], yeezys: ["yeezy"], nb: ["new balance"], af1: ["air force 1"],
  af1s: ["air force 1"], am1: ["air max 1"], am90: ["air max 90"], ts: ["travis scott"],
  cactus: ["travis scott"], ow: ["off-white"], offwhite: ["off-white"],
  wemby: ["wembanyama"], mj: ["jordan"], bron: ["lebron"], sga: ["gilgeous-alexander"],
  ant: ["edwards"], cc: ["caitlin clark"], rc: ["rookie"], autos: ["auto"],
  pkmn: ["pokemon"], "pokémon": ["pokemon"], mtg: ["magic"], ygo: ["yu-gi-oh"],
  blk: ["black"], wht: ["white"], gry: ["grey"], gray: ["grey"],
};
const WORD = /[a-z0-9]+(?:[.\-'][a-z0-9]+)*/g;
const SIZE_PREFIX = /^(?:sz|size|us|men'?s|w|wmns)$/;
const SIZE_GLUED = /^(?:sz|size|us)(\d{1,2}(?:\.5)?)$/;
const SIZE_SUFFIX = /^(\d{1,2}(?:\.5)?)(?:w|y|c|m)$/;
const SIZE_NUMBER = /^\d{1,2}(?:\.5)?$/;

export interface ParsedQuery {
  terms: string[];
  sizes: Set<string>;
  looseNumbers: string[];
}

const words = (s: string): string[] => s.toLowerCase().match(WORD) ?? [];

function normSize(v: string): string {
  const f = Number(v.trim().toLowerCase().replace(/[wycm]$/, ""));
  return Number.isNaN(f) ? v : String(f);
}

export function parseQuery(raw?: string | null): ParsedQuery {
  const q: ParsedQuery = { terms: [], sizes: new Set(), looseNumbers: [] };
  const w = words((raw ?? "").slice(0, 100));
  for (let i = 0; i < w.length; i += 1) {
    const cur = w[i];
    const next = w[i + 1];
    if (GRADERS.has(cur) && next && /^\d{1,2}(?:\.5)?$/.test(next)) {
      q.terms.push(`${cur} ${next}`);
      i += 1;
    } else if (SIZE_PREFIX.test(cur) && next && SIZE_NUMBER.test(next)) {
      q.sizes.add(normSize(next));
      i += 1;
    } else {
      const m = cur.match(SIZE_GLUED) ?? cur.match(SIZE_SUFFIX);
      if (m) q.sizes.add(normSize(m[1]));
      else if (SIZE_NUMBER.test(cur) && Number(cur) <= 18) q.looseNumbers.push(normSize(cur));
      else if (NICKNAMES[cur]) q.terms.push(...NICKNAMES[cur]);
      else q.terms.push(cur);
    }
  }
  return q;
}

function strings(v: unknown, out: string[] = []): string[] {
  if (v == null) return out;
  if (typeof v === "string" || typeof v === "number") out.push(String(v));
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => strings(x, out));
  return out;
}

export function itemSizes(item: Searchable): Set<string> {
  const s = new Set<string>();
  if (item.size) s.add(normSize(item.size));
  const attrs = item.custom_attributes as { variants?: { size?: string; quantity?: number }[] } | null | undefined;
  for (const v of attrs?.variants ?? []) {
    if (v?.size && (v.quantity == null || v.quantity > 0)) s.add(normSize(String(v.size)));
  }
  return s;
}

/** Similarity 0..1 from edit distance where a swapped pair of letters counts as one typo. */
function similar(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}

function termScore(term: string, text: string, ws: string[]): number {
  if (term.includes(" ")) return text.includes(term) ? 1 : 0;
  if (ws.includes(term)) return 1;
  if (term.length >= 2 && ws.some((w) => w.startsWith(term))) return 0.85;
  if (term.length >= 3 && text.includes(term)) return 0.75;
  if (term.length >= 4) {
    const best = Math.max(0, ...ws.filter((w) => Math.abs(w.length - term.length) <= 2).map((w) => similar(term, w)));
    if (best >= 0.8) return best * 0.7;
  }
  return 0;
}

export function scoreItem(item: Searchable, q: ParsedQuery): number {
  const sizes = itemSizes(item);
  if (q.sizes.size && ![...q.sizes].some((s) => sizes.has(s))) return 0;
  const text = ([
    item.name, item.sku, item.upc, item.color, item.category, item.condition,
    item.size, item.platform, item.notes, item.vendor_name, ...strings(item.custom_attributes),
  ] as (string | null | undefined)[]).filter(Boolean).join(" ").toLowerCase();
  const ws = words(text);
  let total = 0;
  for (const t of q.terms) {
    const s = termScore(t, text, ws);
    if (!s) return 0;
    total += s;
  }
  for (const n of q.looseNumbers) {
    if (sizes.has(n)) total += 1;
    else if (ws.includes(n)) total += 0.8;
    else return 0;
  }
  if (q.sizes.size) total += 1;
  const raw = q.terms.join(" ");
  if (raw && [item.sku, item.upc].some((x) => x && x.toLowerCase() === raw)) total += 3;
  if (raw && item.name?.toLowerCase().startsWith(raw)) total += 0.5;
  return total;
}

/** Best match first; items that don't match every word are dropped. Stable for ties. */
export function smartSearch<T extends Searchable>(items: T[], raw?: string | null): T[] {
  const q = parseQuery(raw);
  if (!q.terms.length && !q.sizes.size && !q.looseNumbers.length) return items;
  return items
    .map((item, i) => ({ item, i, s: scoreItem(item, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

/**
 * "Did you mean…" for a search that found nothing: the item whose name is the
 * closest loose match (each word allowed a bigger typo than the main search),
 * or null when nothing is reasonably close.
 */
export function didYouMean<T extends Searchable>(items: T[], raw?: string | null): T | null {
  const q = words(raw ?? "").filter((w) => w.length >= 3);
  if (!q.length) return null;
  let best: T | null = null;
  let bestScore = 0;
  for (const item of items) {
    const ws = words([item.name, item.sku].filter(Boolean).join(" "));
    if (!ws.length) continue;
    let total = 0;
    for (const t of q) {
      const s = Math.max(0, ...ws.map((w) => (w.startsWith(t) ? 1 : similar(t, w))));
      if (s < 0.55) {
        total = 0;
        break;
      }
      total += s;
    }
    const score = total / q.length;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.6 ? best : null;
}
