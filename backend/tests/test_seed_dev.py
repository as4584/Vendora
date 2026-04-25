"""Seed data readiness tests for the local showcase account."""

from seed_dev import ITEMS, build_placeholder_photo


def test_seed_placeholder_photo_urls_are_deterministic():
    front_once = build_placeholder_photo("Jordan 1 Retro High", "front")
    front_twice = build_placeholder_photo("Jordan 1 Retro High", "front")
    back = build_placeholder_photo("Jordan 1 Retro High", "back")

    assert front_once == front_twice
    assert "placehold.co" in front_once
    assert front_once != back


def test_seed_contains_showcase_size_run_items():
    showcase_skus = {item["sku"] for item in ITEMS if item.get("sku", "").startswith("SHOW-")}
    assert "SHOW-AJ1-SIZERUN" in showcase_skus
    assert "SHOW-TEE-SIZERUN" in showcase_skus

    showcase_items = [item for item in ITEMS if item.get("sku") in showcase_skus]
    assert all(item.get("custom_attributes", {}).get("variants") for item in showcase_items)
