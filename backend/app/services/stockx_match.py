"""Intelligent product-name matching for bridging Vendora item names to StockX.

Resellers name items loosely ("Jordan 1 Chicago", "AJ1 chicago lost&found",
"nike dunk panda"), while StockX uses canonical titles ("Jordan 1 Retro High OG
Chicago"). This module normalizes both sides and scores candidates so we surface
the *right* product — and, when we're not confident, a ranked shortlist of
suggestions instead of silently guessing wrong.

Pure functions, no I/O — unit-testable without a StockX token.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# Tokens that add no discriminating signal for sneaker/streetwear matching.
_NOISE = {
    "size", "sz", "us", "eu", "uk", "cm", "mens", "men", "womens", "women",
    "gs", "td", "ps", "the", "a", "an", "og", "retro", "edition",
    "brand", "new", "ds", "vnds", "pair", "shoes", "sneakers",
}

# Common reseller shorthands → canonical tokens, so "aj1" matches "air jordan 1".
_ALIASES = {
    "aj": "air jordan",
    "aj1": "air jordan 1",
    "aj4": "air jordan 4",
    "jordan": "air jordan",
    "yzy": "yeezy",
    "nb": "new balance",
    "af1": "air force 1",
    "sb": "nike sb",
    "tv": "travis",
    "ts": "travis scott",
    "lost": "lost found",
    "lnf": "lost found",
}


def normalize(text: str) -> str:
    """Lowercase, strip punctuation to spaces, collapse whitespace."""
    if not text:
        return ""
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def tokens(text: str) -> list[str]:
    """Normalized, de-noised, alias-expanded token list."""
    out: list[str] = []
    for tok in normalize(text).split(" "):
        if not tok:
            continue
        expanded = _ALIASES.get(tok, tok)
        for part in expanded.split(" "):
            if part and part not in _NOISE:
                out.append(part)
    return out


def _subsequence(query: str, text: str) -> bool:
    """True if the normalized query is an in-order character subsequence of text."""
    q = normalize(query).replace(" ", "")
    t = normalize(text).replace(" ", "")
    if not q:
        return True
    qi = 0
    for ch in t:
        if qi < len(q) and ch == q[qi]:
            qi += 1
    return qi == len(q)


def score(query: str, candidate: str) -> float:
    """Confidence 0..1 that `candidate` is the product `query` refers to.

    Blends: how much of the query's meaningful tokens the candidate covers
    (recall), how focused the candidate is on those tokens (precision), an
    exact normalized-substring bonus, and a character-subsequence fallback.
    """
    q = tokens(query)
    c = tokens(candidate)
    if not q or not c:
        return 0.0
    qs, cs = set(q), set(c)
    inter = qs & cs
    recall = len(inter) / len(qs)
    precision = len(inter) / len(cs)
    nq, nc = normalize(query), normalize(candidate)
    substring_bonus = 1.0 if nq and nq in nc else 0.0
    subseq_bonus = 1.0 if _subsequence(query, candidate) else 0.0
    value = 0.55 * recall + 0.20 * precision + 0.15 * substring_bonus + 0.10 * subseq_bonus
    return round(min(1.0, value), 4)


@dataclass
class Candidate:
    """A scored StockX candidate. `ref` lets callers carry the source object."""
    title: str
    score: float
    index: int
    ref: object = None


def rank(query: str, candidates: list[str], refs: Optional[list] = None) -> list[Candidate]:
    """Return candidates sorted by descending match score."""
    scored = [
        Candidate(title=title, score=score(query, title), index=i, ref=(refs[i] if refs else None))
        for i, title in enumerate(candidates)
    ]
    return sorted(scored, key=lambda c: (c.score, -c.index), reverse=True)


def best_match(
    query: str,
    candidates: list[str],
    refs: Optional[list] = None,
    threshold: float = 0.55,
    margin: float = 0.08,
) -> tuple[Optional[Candidate], list[Candidate]]:
    """Pick the confident best match, else return None + a suggestion shortlist.

    We only auto-select when the top score clears `threshold` AND beats the
    runner-up by `margin` (so two similar colorways don't get confidently
    mismatched). Always returns the top-5 ranked list for an auto-suggest UI.
    """
    ranked = rank(query, candidates, refs)
    if not ranked:
        return None, []
    top = ranked[0]
    runner = ranked[1].score if len(ranked) > 1 else 0.0
    confident = top.score >= threshold and (top.score - runner) >= margin
    return (top if confident else None), ranked[:5]
