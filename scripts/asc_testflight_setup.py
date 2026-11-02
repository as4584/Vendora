"""Inspect and configure Vendora TestFlight metadata through App Store Connect API."""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature


ASC_BASE = "https://api.appstoreconnect.apple.com/v1"
APP_ID = "6813802667"
BUILD_ID = "f2af860c-59a0-4a6a-b1dd-9ce1fd07dfc4"
GROUP_ID = "24988b39-61f1-43ae-84f0-a188841c9b3e"
ISSUER_ID = "44f06245-8fe3-40d3-bb15-6d802b2d60d3"
KEY_ID = "NU89SCTLZ6"
KEY_PATH = Path(r"C:\ProgramData\Vendora\secrets\AuthKey_NU89SCTLZ6.p8")


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def make_token() -> str:
    header = b64url(json.dumps({"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}, separators=(",", ":")).encode())
    now = int(time.time())
    payload = b64url(
        json.dumps(
            {"iss": ISSUER_ID, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
            separators=(",", ":"),
        ).encode()
    )
    signing_input = f"{header}.{payload}".encode("ascii")
    key = serialization.load_pem_private_key(KEY_PATH.read_bytes(), password=None)
    der = key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"{header}.{payload}.{b64url(signature)}"


def asc_request(token: str, method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(
        ASC_BASE + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else None
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        parsed = json.loads(payload) if payload else None
        return exc.code, parsed


def doppler_review_password() -> str:
    token = os.environ.get("DOPPLER_TOKEN", "")
    if not token:
        raise RuntimeError("DOPPLER_TOKEN is unavailable")
    auth = base64.b64encode(f"{token}:".encode()).decode()
    request = urllib.request.Request(
        "https://api.doppler.com/v3/configs/config/secrets?project=lexmakesit&config=prd",
        headers={"Authorization": f"Basic {auth}"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    return payload["secrets"]["VENDORA_TESTFLIGHT_REVIEW_PASSWORD"]["raw"]


def error_summary(payload: dict | None) -> list[dict]:
    return [
        {
            "status": item.get("status"),
            "code": item.get("code"),
            "title": item.get("title"),
            "detail": item.get("detail"),
            "source": item.get("source"),
        }
        for item in (payload or {}).get("errors", [])
    ]


def inspect(token: str) -> dict:
    review_status, review = asc_request(
        token,
        "GET",
        f"/betaAppReviewDetails?filter%5Bapp%5D={APP_ID}",
    )
    localization_status, localizations = asc_request(
        token,
        "GET",
        f"/betaAppLocalizations?filter%5Bapp%5D={APP_ID}",
    )
    group_status, group_builds = asc_request(
        token,
        "GET",
        f"/betaGroups/{GROUP_ID}/relationships/builds",
    )
    submission_status, submissions = asc_request(
        token,
        "GET",
        f"/betaAppReviewSubmissions?filter%5Bbuild%5D={BUILD_ID}",
    )

    review_rows = []
    for item in (review or {}).get("data", []):
        attrs = item.get("attributes", {})
        review_rows.append(
            {
                "id": item.get("id"),
                "present": {
                    name: bool(attrs.get(name))
                    for name in (
                        "contactFirstName",
                        "contactLastName",
                        "contactPhone",
                        "contactEmail",
                        "demoAccountName",
                        "demoAccountPassword",
                    )
                },
                "demoAccountRequired": attrs.get("demoAccountRequired"),
            }
        )
    localization_rows = [
        {
            "id": item.get("id"),
            "locale": item.get("attributes", {}).get("locale"),
            "descriptionPresent": bool(item.get("attributes", {}).get("description")),
            "feedbackEmailPresent": bool(item.get("attributes", {}).get("feedbackEmail")),
        }
        for item in (localizations or {}).get("data", [])
    ]
    return {
        "reviewDetails": {"status": review_status, "data": review_rows, "errors": error_summary(review)},
        "localizations": {"status": localization_status, "data": localization_rows, "errors": error_summary(localizations)},
        "groupBuilds": {
            "status": group_status,
            "buildIds": [item.get("id") for item in (group_builds or {}).get("data", [])],
            "errors": error_summary(group_builds),
        },
        "submissions": {
            "status": submission_status,
            "states": [item.get("attributes", {}).get("betaReviewState") for item in (submissions or {}).get("data", [])],
            "errors": error_summary(submissions),
        },
    }


def apply(token: str) -> dict:
    current = inspect(token)
    review_rows = current["reviewDetails"]["data"]
    localization_rows = current["localizations"]["data"]
    if not review_rows:
        raise RuntimeError("Apple returned no betaAppReviewDetails resource for the app")
    review_id = review_rows[0]["id"]
    password = doppler_review_password()

    review_body = {
        "data": {
            "type": "betaAppReviewDetails",
            "id": review_id,
            "attributes": {
                "contactFirstName": "Alexander",
                "contactLastName": "Santiago",
                "contactPhone": "+1 973-653-0992",
                "contactEmail": "Lexlations@icloud.com",
                "demoAccountRequired": True,
                "demoAccountName": "apple-review@lexmakesit.com",
                "demoAccountPassword": password,
            },
        }
    }
    review_status, review_result = asc_request(token, "PATCH", f"/betaAppReviewDetails/{review_id}", review_body)
    localization_attrs = {
        "description": "Vendora helps resellers manage inventory, record sales, work offline at events, and automatically sync changes when connectivity returns.",
        "feedbackEmail": "Lexlations@icloud.com",
    }
    if localization_rows:
        locale_id = next(
            (row["id"] for row in localization_rows if row["locale"] == "en-US"),
            localization_rows[0]["id"],
        )
        localization_body = {
            "data": {
                "type": "betaAppLocalizations",
                "id": locale_id,
                "attributes": localization_attrs,
            }
        }
        localization_status, localization_result = asc_request(
            token, "PATCH", f"/betaAppLocalizations/{locale_id}", localization_body
        )
    else:
        localization_body = {
            "data": {
                "type": "betaAppLocalizations",
                "attributes": {"locale": "en-US", **localization_attrs},
                "relationships": {
                    "app": {"data": {"type": "apps", "id": APP_ID}}
                },
            }
        }
        localization_status, localization_result = asc_request(
            token, "POST", "/betaAppLocalizations", localization_body
        )
    link_status, link_result = asc_request(
        token,
        "POST",
        f"/builds/{BUILD_ID}/relationships/betaGroups",
        {"data": [{"type": "betaGroups", "id": GROUP_ID}]},
    )
    return {
        "reviewUpdate": {"status": review_status, "errors": error_summary(review_result)},
        "localizationUpdate": {"status": localization_status, "errors": error_summary(localization_result)},
        "groupLink": {"status": link_status, "errors": error_summary(link_result)},
        "after": inspect(token),
    }


def submit(token: str) -> dict:
    status, result = asc_request(
        token,
        "POST",
        "/betaAppReviewSubmissions",
        {
            "data": {
                "type": "betaAppReviewSubmissions",
                "relationships": {"build": {"data": {"type": "builds", "id": BUILD_ID}}},
            }
        },
    )
    return {
        "status": status,
        "submissionId": (result or {}).get("data", {}).get("id"),
        "state": (result or {}).get("data", {}).get("attributes", {}).get("betaReviewState"),
        "errors": error_summary(result),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("inspect", "apply", "submit"))
    args = parser.parse_args()
    token = make_token()
    if args.action == "inspect":
        result = inspect(token)
    elif args.action == "apply":
        result = apply(token)
    else:
        result = submit(token)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
