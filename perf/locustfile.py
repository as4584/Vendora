"""Realistic Vendora user behavior for load testing.

Each simulated user is a reseller on the iPhone app: signs up, logs in, opens
the app (profile, feature flags, subscription, dashboard), then browses and
records work with mobile-style think time. Every user gets its own
CF-Connecting-IP, as Cloudflare would send, so per-IP rate limits apply per
user rather than to the whole test.

Run only against the load-test clone (perf/docker-compose.loadtest.yml).
"""
import itertools
import json
import os
import random
import uuid

from locust import HttpUser, between, task

_ip_counter = itertools.count(1)
PASSWORD = "LoadTest-Passw0rd!"
# Pre-seeded sessions (seed_users.py): steady-state users are already logged in.
_TOKENS = json.load(open(os.environ["VENDORA_TOKENS"])) if os.environ.get("VENDORA_TOKENS") else []
_token_iter = itertools.cycle(_TOKENS) if _TOKENS else None


def _next_ip() -> str:
    n = next(_ip_counter)
    return f"10.{(n >> 16) & 255}.{(n >> 8) & 255}.{n & 255}"


class Reseller(HttpUser):
    wait_time = between(3, 10)  # seconds between taps on a phone

    def on_start(self):
        self.headers = {"CF-Connecting-IP": _next_ip()}
        self.item_ids: list[str] = []
        if _token_iter:
            self.headers["Authorization"] = f"Bearer {next(_token_iter)}"
            self.open_app()
            return
        email = f"lt-{uuid.uuid4().hex[:12]}@loadtest.invalid"
        self.client.post(
            "/api/v1/auth/register",
            json={"email": email, "password": PASSWORD, "business_name": "Load Test Shop"},
            headers=self.headers,
            name="POST /auth/register",
        )
        resp = self.client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": PASSWORD},
            headers=self.headers,
            name="POST /auth/login",
        )
        if resp.ok:
            self.headers["Authorization"] = f"Bearer {resp.json()['access_token']}"
        self.open_app()

    def _get(self, path, name=None):
        return self.client.get(f"/api/v1{path}", headers=self.headers, name=name or f"GET {path}")

    def open_app(self):
        self._get("/auth/me")
        self._get("/features")
        self._get("/subscriptions/me")
        self._get("/dashboard")

    @task(6)
    def browse_inventory(self):
        resp = self._get(f"/inventory?page=1&per_page=20", name="GET /inventory")
        if resp.ok:
            ids = [i["id"] for i in resp.json().get("items", [])]
            if ids:
                self.item_ids = ids

    @task(4)
    def view_dashboard(self):
        self._get("/dashboard")

    @task(3)
    def view_item(self):
        if self.item_ids:
            item_id = random.choice(self.item_ids)
            self._get(f"/inventory/{item_id}", name="GET /inventory/{id}")
            self._get(f"/inventory/{item_id}/activity?limit=20", name="GET /inventory/{id}/activity")

    @task(3)
    def view_sales(self):
        self._get("/transactions?page=1&per_page=20", name="GET /transactions")

    @task(2)
    def add_item(self):
        price = random.randint(10, 300)
        with self.client.post(
            "/api/v1/inventory",
            json={
                "name": f"Item {uuid.uuid4().hex[:6]}",
                "category": random.choice(["Sneakers", "Apparel", "Cards", "Electronics"]),
                "buy_price": str(price),
                "expected_sell_price": str(price * 2),
                "quantity": random.randint(1, 5),
            },
            headers=self.headers,
            name="POST /inventory",
            catch_response=True,
        ) as resp:
            if resp.ok:
                self.item_ids.append(resp.json()["id"])
            elif resp.status_code == 403:
                # Free-plan accounts are capped at 25 items; long runs hit the
                # cap. That is the app working, not a capacity failure.
                resp.success()

    @task(2)
    def quick_sale(self):
        if not self.item_ids:
            return
        with self.client.post(
            "/api/v1/transactions",
            json={
                "item_id": random.choice(self.item_ids),
                "method": random.choice(["cash", "venmo", "cashapp"]),
                "gross_amount": str(random.randint(20, 400)),
                "quantity": 1,
                "client_request_id": uuid.uuid4().hex,
            },
            headers=self.headers,
            name="POST /transactions (quick sale)",
            catch_response=True,
        ) as resp:
            # Selling an item that is already sold out is a correct 409, not a failure.
            if resp.status_code == 409:
                resp.success()

    @task(1)
    def view_invoices(self):
        self._get("/invoices", name="GET /invoices")

    @task(1)
    def reopen_app(self):
        self.open_app()


from locust import LoadTestShape  # noqa: E402


class StepRamp(LoadTestShape):
    """Breakpoint test: add STEP users every STEP_SECONDS up to MAX_USERS."""

    start = int(os.environ.get("START", 0))
    step = int(os.environ.get("STEP", 100))
    step_seconds = int(os.environ.get("STEP_SECONDS", 90))
    max_users = int(os.environ.get("MAX_USERS", 3000))
    spawn_rate = float(os.environ.get("SPAWN_RATE", 20))

    def tick(self):
        users = self.start + (int(self.get_run_time() // self.step_seconds) + 1) * self.step
        if users > self.max_users:
            return None
        return users, self.spawn_rate
