"""Third-party clean-up when a user deletes their Resqlo account (App Store 5.1.1(v)).

Order in DELETE /auth/account:
  1. cancel_user_subscriptions  - Stripe subs are cancelled (hard failure aborts).
  2. revoke_third_party_access  - this module, best effort, never blocks deletion.
  3. db.delete(user)            - every user-owned row goes via ON DELETE CASCADE.

What "revoke" means per provider:
  * Google  - the refresh token is revoked at oauth2.googleapis.com/revoke.
  * eBay, StockX, Lightspeed, Square, Clover - none of these offer a simple
    user-token revoke we can call here, so the encrypted tokens are deleted
    explicitly (the tokens expire on their side; the user can also remove the
    app from their account on each marketplace).
  * RevenueCat - when REVENUECAT_SECRET_KEY is set, the RevenueCat customer
    (app user id == Resqlo user id) is deleted. Apple subscriptions themselves
    can only be cancelled by the user in their Apple ID settings; the app tells
    them so before they delete.
"""
from __future__ import annotations

import logging
from typing import Callable

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models.clover import CloverCredential
from app.models.google_sheets import GoogleToken
from app.models.integration import EbayToken, LightspeedToken
from app.models.square import SquareCredential
from app.models.stockx import StockxToken
from app.models.user import User
from app.security.token_encryption import decrypt_token

logger = logging.getLogger(__name__)

GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
REVENUECAT_SUBSCRIBER_URL = "https://api.revenuecat.com/v1/subscribers/{app_user_id}"

TOKEN_MODELS = (EbayToken, StockxToken, GoogleToken, LightspeedToken, SquareCredential, CloverCredential)


def _http(method: str, url: str, **kwargs) -> httpx.Response:
    with httpx.Client(timeout=10) as client:
        return client.request(method, url, **kwargs)


# Tests swap this for a fake so no network call is made.
http_request: Callable[..., httpx.Response] = _http


def _revoke_google(db: Session, user: User) -> bool:
    token = db.query(GoogleToken).filter(GoogleToken.user_id == user.id).one_or_none()
    if token is None:
        return False
    raw = decrypt_token(token.refresh_token) or decrypt_token(token.access_token)
    if not raw:
        return False
    try:
        http_request("POST", GOOGLE_REVOKE_URL, data={"token": raw})
        return True
    except httpx.HTTPError:
        logger.warning("Google token revoke failed during account deletion; deleting locally")
        return False


def _delete_revenuecat_customer(user: User) -> bool:
    key = settings.REVENUECAT_SECRET_KEY
    if not key:
        return False
    try:
        response = http_request(
            "DELETE",
            REVENUECAT_SUBSCRIBER_URL.format(app_user_id=str(user.id)),
            headers={"Authorization": f"Bearer {key}"},
        )
        return response.status_code < 300 or response.status_code == 404
    except httpx.HTTPError:
        logger.warning("RevenueCat customer delete failed during account deletion")
        return False


def revoke_third_party_access(db: Session, user: User) -> dict[str, bool]:
    """Revoke/forget every external credential for ``user``. Never raises."""
    result = {"google_revoked": False, "revenuecat_deleted": False}
    try:
        result["google_revoked"] = _revoke_google(db, user)
    except Exception:  # noqa: BLE001 - deletion must not be blocked by a provider
        logger.exception("Unexpected error revoking Google access")
    try:
        result["revenuecat_deleted"] = _delete_revenuecat_customer(user)
    except Exception:  # noqa: BLE001
        logger.exception("Unexpected error deleting RevenueCat customer")
    for model in TOKEN_MODELS:
        db.query(model).filter(model.user_id == user.id).delete(synchronize_session=False)
    db.flush()
    return result
