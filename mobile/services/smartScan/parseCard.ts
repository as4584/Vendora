/**
 * Turns text read off a trading card or a graded slab label into item fields.
 * Pure and offline, same contract as parseBoxLabel: anything not confidently
 * found is left out, so the seller only fixes what's missing.
 *
 * Slab label (PSA style):          Raw card:
 *   2023 POKEMON SV151 EN            Charizard ex           HP 330
 *   CHARIZARD ex                     ...attack text...
 *   SPECIAL ILLUSTRATION RARE        199/165  Illus. ...
 *   #199          GEM MT 10
 *   12345678
 */
import type { ScanFields } from "./parseLabel";

const GRADERS: [RegExp, string][] = [
  [/\bPSA\b/i, "PSA"],
  [/\b(BGS|BECKETT)\b/i, "BGS"],
  [/\bCGC\b/i, "CGC"],
  [/\bSGC\b/i, "SGC"],
  [/\bTAG\s+GRAD/i, "TAG"],
];

const GAMES: [RegExp, string][] = [
  [/\bPOK[EÉ]MON\b/i, "Pokemon"],
  [/\bMAGIC\b.*\bGATHERING\b|\bMTG\b/i, "Magic"],
  [/\bYU-?GI-?OH/i, "Yu-Gi-Oh"],
  [/\bONE\s*PIECE\b/i, "One Piece"],
  [/\bLORCANA\b/i, "Lorcana"],
  [/\bTOPPS\b/i, "Topps"],
  [/\bPANINI\b/i, "Panini"],
  [/\bUPPER\s*DECK\b/i, "Upper Deck"],
  [/\bBOWMAN\b/i, "Bowman"],
  [/\bDONRUSS\b/i, "Donruss"],
  [/\bPRIZM\b/i, "Panini"],
  [/\bFLEER\b/i, "Fleer"],
];

// Grade words a slab prints next to the number.
const GRADE = /\b(GEM\s*MT|GEM\s*MINT|PRISTINE|BLACK\s*LABEL|MINT|NM-?MT\+?|NM|EX-?MT|EX|VG-?EX|VG|GOOD|FAIR|POOR|AUTHENTIC)?\s*(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)\b/i;
const YEAR = /\b(19[5-9]\d|20[0-4]\d)\b/;
const SET_NUMBER = /\b(\d{1,3})\s*\/\s*(\d{2,3})\b/; // 199/165 on raw Pokemon cards
const HASH_NUMBER = /#\s?([A-Z]{0,4}\d{1,4}[A-Z]?)\b/i; // #199, #RC12 on slabs
const CERT = /\b(\d{7,10})\b/; // slab cert number
const PSA_WORDING = /\b(GEM\s*MT|NM-MT|EX-MT|VG-EX)\s*\d/i;
const HP = /\bHP\s*\d{2,3}\b|\b\d{2,3}\s*HP\b/i;
// Lines that are rules text, not the card's name.
const NOISE = /\b(HP|WEAKNESS|RESISTANCE|RETREAT|ILLUS|NINTENDO|CREATURES|GAME\s*FREAK|WIZARDS|©|TM|ABILITY|ATTACK|DAMAGE|POK[EÉ]MON\s+(TCG|CARD)|CERT|PSA|BGS|CGC|SGC|BECKETT|GEM|MINT|AUTHENTIC|RARE|HOLO|REVERSE|ILLUSTRATION)\b/i;

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (/^(ex|gx|v|vmax|vstar)$/.test(w) ? (w === "ex" ? "ex" : w.toUpperCase()) : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function looksLikeCardName(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 40) return false;
  if (NOISE.test(t) || YEAR.test(t) || SET_NUMBER.test(t)) return false;
  const letters = (t.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
  return letters / t.length > 0.7 && !/\d{3,}/.test(t);
}

/** True when the text reads like a card or slab rather than a shoe box. */
export function looksLikeCard(rawLines: string[]): boolean {
  const text = rawLines.join("\n");
  if (GRADERS.some(([re]) => re.test(text)) || PSA_WORDING.test(text)) return true;
  if (GAMES.some(([re]) => re.test(text))) return true;
  return HP.test(text) && SET_NUMBER.test(text);
}

export function parseCardLabel(rawLines: string[]): ScanFields {
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  const text = lines.join("\n");
  const out: ScanFields = { category: "collectibles" };

  // PSA prints its logo as an image, but its grade wording ("GEM MT 10", "NM-MT 8") is its own.
  const grader = GRADERS.find(([re]) => re.test(text))?.[1] ?? (PSA_WORDING.test(text) ? "PSA" : undefined);
  const game = GAMES.find(([re]) => re.test(text))?.[1];
  if (game) out.brand = game;

  if (grader) {
    // The grade sits on a line of its own or next to the grade words; never the cert or the year.
    const gradeLine = lines.find((l) => GRADE.test(l) && !CERT.test(l) && !YEAR.test(l) && !SET_NUMBER.test(l) && !/^#/.test(l));
    const g = gradeLine?.match(GRADE);
    out.condition = g ? `${grader} ${g[2]}` : grader;
    const cert = lines.map((l) => l.match(CERT)?.[1]).find((c) => c && !YEAR.test(c));
    if (cert) out.sku = `${grader}-${cert}`;
  } else {
    out.condition = "Raw";
  }

  const year = text.match(YEAR)?.[1];
  const number = text.match(SET_NUMBER)?.[1] ?? text.match(HASH_NUMBER)?.[1];

  // Slab: the card name is the line after the year/game header. Raw card: the first name-like line.
  let name: string | undefined;
  const headerIdx = lines.findIndex((l) => YEAR.test(l) && GAMES.some(([re]) => re.test(l)));
  if (headerIdx >= 0) name = lines.slice(headerIdx + 1).find(looksLikeCardName);
  name ??= lines.find(looksLikeCardName);

  if (name) {
    out.name = [year, game, titleCase(name), number ? `#${number}` : undefined].filter(Boolean).join(" ");
  }
  return out;
}
