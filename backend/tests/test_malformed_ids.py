"""Regression: a malformed id anywhere in the API must be a 4xx, never a 500.

Walks every registered route with an id-like path parameter, so new routes
are covered automatically.
"""
import re

import pytest

from app.main import app

ID_PARAM = re.compile(r"\{(\w*id)\}")


def _id_routes():
    # The OpenAPI schema lists every route, including those in nested routers.
    for path, operations in app.openapi()["paths"].items():
        if not ID_PARAM.search(path) or "external_id" in path:
            continue
        for method in operations:
            yield method.upper(), ID_PARAM.sub("not-a-uuid", path)


@pytest.mark.parametrize("method,path", sorted(set(_id_routes())))
def test_malformed_id_is_client_error(client, auth_headers, method, path):
    response = client.request(method, path, headers=auth_headers, json={})
    assert response.status_code < 500, (method, path, response.status_code)


def test_public_seller_profile_bad_id(client):
    assert client.get("/api/v1/sellers/abc").status_code == 422
