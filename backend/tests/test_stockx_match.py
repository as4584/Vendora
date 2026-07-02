"""Unit tests for the StockX product-name matching intelligence (no I/O)."""
from app.services import stockx_match as m


def test_normalize_and_tokens_are_case_and_punct_insensitive():
    assert m.normalize("Jordan 1 — Chicago!!") == "jordan 1 chicago"
    assert m.tokens("AJ1 Chicago (OG)") == ["air", "jordan", "1", "chicago"]
    # noise + aliases: "retro"/"og" dropped, "aj" → "air jordan"
    assert "retro" not in m.tokens("Air Jordan 1 Retro OG")


def test_score_prefers_the_right_colorway():
    q = "Jordan 1 Chicago"
    chicago = m.score(q, "Jordan 1 Retro High OG Chicago")
    bred = m.score(q, "Jordan 1 Retro High OG Bred")
    panda = m.score(q, "Nike Dunk Low Panda")
    assert chicago > bred > panda
    assert chicago >= 0.7


def test_best_match_auto_selects_a_clear_winner():
    q = "aj1 chicago"
    cands = [
        "Nike Dunk Low Panda",
        "Air Jordan 1 Retro High OG Chicago",
        "Adidas Yeezy Boost 350 V2 Zebra",
    ]
    best, ranked = m.best_match(q, cands)
    assert best is not None
    assert best.title == "Air Jordan 1 Retro High OG Chicago"
    assert ranked[0].title == best.title
    assert len(ranked) <= 5


def test_best_match_defers_to_suggestions_when_ambiguous():
    # Two near-identical colorways → don't confidently pick; return the shortlist.
    q = "jordan 4"
    cands = ["Air Jordan 4 Retro Bred", "Air Jordan 4 Retro Fire Red"]
    best, ranked = m.best_match(q, cands)
    assert best is None
    assert len(ranked) == 2
    assert all(c.score > 0 for c in ranked)


def test_refs_are_carried_through():
    cands = ["Air Jordan 1 Chicago"]
    refs = [{"productId": "abc-123"}]
    _, ranked = m.best_match("jordan 1 chicago", cands, refs=refs)
    assert ranked[0].ref == {"productId": "abc-123"}


def test_empty_and_no_candidates_are_safe():
    assert m.score("", "anything") == 0.0
    best, ranked = m.best_match("jordan", [])
    assert best is None and ranked == []
