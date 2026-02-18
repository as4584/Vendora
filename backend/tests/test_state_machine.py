"""State machine tests — full 6x6 transition matrix.

Per STATE_MACHINES.md:
  in_stock → listed, sold
  listed → sold, in_stock
  sold → shipped, paid
  shipped → paid
  paid → archived
  archived → (terminal, no transitions)
"""
import pytest


VALID_TRANSITIONS = [
    ("in_stock", "listed"),
    ("in_stock", "sold"),
    ("listed", "sold"),
    ("listed", "in_stock"),
    ("sold", "shipped"),
    ("sold", "paid"),
    ("shipped", "paid"),
    ("paid", "archived"),
]

ALL_STATUSES = ["in_stock", "listed", "sold", "shipped", "paid", "archived"]

# Generate all invalid transitions (36 total combos minus 8 valid minus 6 same-state)
INVALID_TRANSITIONS = [
    (current, target)
    for current in ALL_STATUSES
    for target in ALL_STATUSES
    if (current, target) not in VALID_TRANSITIONS and current != target
]


def _create_item_with_status(client, auth_headers, target_status: str) -> str:
    """Helper: create an item and walk it through transitions to reach target_status."""
    # Path to reach each status
    STATUS_PATHS = {
        "in_stock": [],
        "listed": ["listed"],
        "sold": ["sold"],
        "shipped": ["sold", "shipped"],
        "paid": ["sold", "paid"],
        "archived": ["sold", "paid", "archived"],
    }

    resp = client.post("/api/v1/inventory", json={"name": "State Test Item"}, headers=auth_headers)
    assert resp.status_code == 201
    item_id = resp.json()["id"]

    for step_status in STATUS_PATHS[target_status]:
        resp = client.patch(
            f"/api/v1/inventory/{item_id}/status",
            json={"status": step_status},
            headers=auth_headers,
        )
        assert resp.status_code == 200, f"Failed to transition to {step_status}: {resp.json()}"

    return item_id


class TestValidTransitions:
    @pytest.mark.parametrize("current,target", VALID_TRANSITIONS)
    def test_valid_transition(self, client, auth_headers, current, target):
        item_id = _create_item_with_status(client, auth_headers, current)
        resp = client.patch(
            f"/api/v1/inventory/{item_id}/status",
            json={"status": target},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == target


class TestInvalidTransitions:
    @pytest.mark.parametrize("current,target", INVALID_TRANSITIONS)
    def test_invalid_transition(self, client, auth_headers, current, target):
        item_id = _create_item_with_status(client, auth_headers, current)
        resp = client.patch(
            f"/api/v1/inventory/{item_id}/status",
            json={"status": target},
            headers=auth_headers,
        )
        assert resp.status_code == 400
        data = resp.json()["detail"]
        assert data["error"] == "invalid_transition"
        assert data["current_status"] == current
        assert data["target_status"] == target


class TestTerminalState:
    def test_archived_is_terminal(self, client, auth_headers):
        """Archived items cannot transition to any state."""
        item_id = _create_item_with_status(client, auth_headers, "archived")
        for target in ALL_STATUSES:
            if target == "archived":
                continue
            resp = client.patch(
                f"/api/v1/inventory/{item_id}/status",
                json={"status": target},
                headers=auth_headers,
            )
            assert resp.status_code == 400


class TestInvalidStatusValue:
    def test_unknown_status(self, client, auth_headers):
        resp = client.post("/api/v1/inventory", json={"name": "Test"}, headers=auth_headers)
        item_id = resp.json()["id"]
        resp = client.patch(
            f"/api/v1/inventory/{item_id}/status",
            json={"status": "bogus"},
            headers=auth_headers,
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"] == "invalid_status"
