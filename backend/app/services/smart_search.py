"""Inventory search that thinks like a sneaker/card seller.

- Every word must match somewhere (name, SKU, UPC, color, category, size, notes,
  card details in custom attributes), but typos are tolerated ("jordon" -> Jordan).
- Sizes: "sz 10", "size 10.5", "10w" filter by size; a bare "10" matches size or text.
- Nicknames: "aj1", "pandas", "yzy", "nb", "rc" expand to what sellers mean.
- Grades: "psa 10", "bgs 9.5" stay together as one phrase.
- Results are ranked best match first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any, Iterable, Optional

MAX_QUERY = 100
GRADERS = ("psa", "bgs", "cgc", "sgc", "tag", "beckett")

# Seller shorthand -> words that appear in listings. Multi-word values are a phrase.
NICKNAMES: dict[str, list[str]] = {
    "aj": ["jordan"],
    "aj1": ["jordan 1"],
    "aj3": ["jordan 3"],
    "aj4": ["jordan 4"],
    "aj11": ["jordan 11"],
    "j1": ["jordan 1"],
    "j4": ["jordan 4"],
    "j11": ["jordan 11"],
    "jordans": ["jordan"],
    "dunks": ["dunk"],
    "pandas": ["panda"],
    "yzy": ["yeezy"],
    "yeezys": ["yeezy"],
    "nb": ["new balance"],
    "af1": ["air force 1"],
    "af1s": ["air force 1"],
    "am1": ["air max 1"],
    "am90": ["air max 90"],
    "ts": ["travis scott"],
    "cactus": ["travis scott"],
    "ow": ["off-white"],
    "offwhite": ["off-white"],
    "bred": ["bred"],
    "unc": ["unc"],
    "wemby": ["wembanyama"],
    "mj": ["jordan"],
    "bron": ["lebron"],
    "kobe": ["kobe"],
    "sga": ["gilgeous-alexander"],
    "ant": ["edwards"],
    "cc": ["caitlin clark"],
    "rc": ["rookie"],
    "rookie": ["rookie"],
    "auto": ["auto"],
    "autos": ["auto"],
    "pkmn": ["pokemon"],
    "pokémon": ["pokemon"],
    "mtg": ["magic"],
    "ygo": ["yu-gi-oh"],
    "blk": ["black"],
    "wht": ["white"],
    "gry": ["grey"],
    "gray": ["grey"],
}

_SIZE_PREFIX = re.compile(r"^(?:sz|size|us|men'?s|w|wmns)$")
_SIZE_GLUED = re.compile(r"^(?:sz|size|us)(\d{1,2}(?:\.5)?)$")
_SIZE_SUFFIX = re.compile(r"^(\d{1,2}(?:\.5)?)(?:w|y|c|m)$")
_SIZE_NUMBER = re.compile(r"^\d{1,2}(?:\.5)?$")
_WORD = re.compile(r"[a-z0-9]+(?:[.\-'][a-z0-9]+)*")


@dataclass
class Query:
    terms: list[str] = field(default_factory=list)  # each must match (phrases allowed)
    sizes: set[str] = field(default_factory=set)  # explicit size filter
    loose_numbers: list[str] = field(default_factory=list)  # bare numbers: size OR text

    @property
    def empty(self) -> bool:
        return not (self.terms or self.sizes or self.loose_numbers)


def _norm_size(v: str) -> str:
    v = v.strip().lower().rstrip("wycm")
    try:
        f = float(v)
    except ValueError:
        return v
    return str(int(f)) if f == int(f) else str(f)


def parse(raw: Optional[str]) -> Query:
    q = Query()
    if not raw:
        return q
    words = _WORD.findall(raw.lower()[:MAX_QUERY])
    i = 0
    while i < len(words):
        w = words[i]
        nxt = words[i + 1] if i + 1 < len(words) else None
        if w in GRADERS and nxt and re.fullmatch(r"\d{1,2}(?:\.5)?", nxt):
            q.terms.append(f"{w} {nxt}")
            i += 2
            continue
        if _SIZE_PREFIX.match(w) and nxt and _SIZE_NUMBER.match(nxt):
            q.sizes.add(_norm_size(nxt))
            i += 2
            continue
        m = _SIZE_GLUED.match(w) or _SIZE_SUFFIX.match(w)
        if m:
            q.sizes.add(_norm_size(m.group(1)))
        elif _SIZE_NUMBER.match(w) and float(w) <= 18:
            q.loose_numbers.append(_norm_size(w))
        elif w in NICKNAMES:
            q.terms.extend(NICKNAMES[w])
        else:
            q.terms.append(w)
        i += 1
    return q


def _strings(value: Any) -> Iterable[str]:
    if value is None:
        return
    if isinstance(value, str):
        yield value
    elif isinstance(value, (int, float)):
        yield str(value)
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _strings(v)


def item_sizes(item: Any) -> set[str]:
    sizes = {_norm_size(item.size)} if getattr(item, "size", None) else set()
    attrs = getattr(item, "custom_attributes", None) or {}
    for v in attrs.get("variants") or [] if isinstance(attrs, dict) else []:
        if (
            isinstance(v, dict)
            and v.get("size")
            and (v.get("quantity") is None or v.get("quantity", 0) > 0)
        ):
            sizes.add(_norm_size(str(v["size"])))
    return sizes


def haystack(item: Any) -> str:
    parts = [
        item.name,
        item.sku,
        item.upc,
        item.color,
        item.category,
        item.condition,
        item.size,
        item.platform,
        getattr(item, "notes", None),
        getattr(item, "vendor_name", None),
    ]
    parts.extend(_strings(getattr(item, "custom_attributes", None)))
    return " ".join(p for p in parts if p).lower()


def _term_score(term: str, text: str, words: list[str]) -> float:
    if " " in term:
        return 1.0 if term in text else 0.0
    if any(w == term for w in words):
        return 1.0
    if any(w.startswith(term) for w in words) and len(term) >= 2:
        return 0.85
    if len(term) >= 3 and term in text:
        return 0.75  # inside a word or SKU, e.g. "1391" in "dd1391-100"
    if len(term) >= 4:
        best = max(
            (
                SequenceMatcher(None, term, w).ratio()
                for w in words
                if abs(len(w) - len(term)) <= 2
            ),
            default=0,
        )
        if best >= 0.8:
            return best * 0.7  # typo
    return 0.0


def score(item: Any, q: Query) -> float:
    """0 = not a match. Higher is better."""
    if q.sizes and not (item_sizes(item) & q.sizes):
        return 0.0
    text = haystack(item)
    words = _WORD.findall(text)
    total = 0.0
    for term in q.terms:
        s = _term_score(term, text, words)
        if s == 0:
            return 0.0
        total += s
    sizes = item_sizes(item)
    for n in q.loose_numbers:
        if n in sizes:
            total += 1.0
        elif n in words:
            total += 0.8
        else:
            return 0.0
    if q.sizes:
        total += 1.0
    raw = " ".join(q.terms)
    for exact in (item.sku, item.upc):
        if exact and raw and exact.lower() == raw:
            total += 3.0
    if item.name and raw and item.name.lower().startswith(raw):
        total += 0.5
    return total


def rank(items: Iterable[Any], raw: Optional[str]) -> list[Any]:
    q = parse(raw)
    if q.empty:
        return list(items)
    scored = [(score(it, q), it) for it in items]
    return [
        it for s, it in sorted((p for p in scored if p[0] > 0), key=lambda p: -p[0])
    ]
