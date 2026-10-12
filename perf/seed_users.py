"""Create load-test accounts on the clone and save their access tokens."""
import json, sys, uuid
from concurrent.futures import ThreadPoolExecutor
import httpx

HOST = sys.argv[1]; N = int(sys.argv[2]); OUT = sys.argv[3]
PW = "LoadTest-Passw0rd!"

def make(i):
    ip = {"CF-Connecting-IP": f"10.200.{i >> 8 & 255}.{i & 255}"}
    email = f"seed-{uuid.uuid4().hex[:12]}@loadtest.invalid"
    with httpx.Client(base_url=HOST, timeout=60) as c:
        c.post("/api/v1/auth/register", json={"email": email, "password": PW, "business_name": "LT"}, headers=ip).raise_for_status()
        r = c.post("/api/v1/auth/login", json={"email": email, "password": PW}, headers=ip); r.raise_for_status()
        return r.json()["access_token"]

with ThreadPoolExecutor(8) as ex:
    tokens = list(ex.map(make, range(N)))
json.dump(tokens, open(OUT, "w"))
print(len(tokens), "tokens")
