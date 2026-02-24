"""Lightspeed Retail (R-Series) integration helpers."""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
import uuid
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.config import settings
from app.models.integration import LightspeedToken


class LightspeedService:
    AUTH_URL = "https://cloud.lightspeedapp.com/oauth/authorize.php"
    TOKEN_URL = "https://cloud.lightspeedapp.com/oauth/access_token.php"

    def __init__(self) -> None:
        self.client_id = settings.LIGHTSPEED_CLIENT_ID
        self.client_secret = settings.LIGHTSPEED_CLIENT_SECRET
        self.redirect_uri = settings.LIGHTSPEED_REDIRECT_URI

    def _assert_configured(self) -> None:
        if not (self.client_id and self.client_secret and self.redirect_uri):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Lightspeed integration is not configured yet.",
            )

    def build_state(self, user_id: uuid.UUID) -> str:
        nonce = secrets.token_urlsafe(8)
        return f"{user_id}:{nonce}"

    def parse_state(self, state: str) -> uuid.UUID:
        try:
            user_id_str = state.split(":", 1)[0]
            return uuid.UUID(user_id_str)
        except Exception as exc:  # pragma: no cover - defensive guard
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Lightspeed state parameter") from exc

    def authorization_url(self, state: str, scope: str = "employee:all inventory:all") -> str:
        self._assert_configured()
        params = urlencode(
            {
                "response_type": "code",
                "client_id": self.client_id,
                "redirect_uri": self.redirect_uri,
                "scope": scope,
                "state": state,
            }
        )
        return f"{self.AUTH_URL}?{params}"

    async def exchange_authorization_code(self, code: str) -> dict:
        self._assert_configured()
        data = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": self.redirect_uri,
        }
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(self.TOKEN_URL, data=data)
        if response.status_code >= 400:
            raise HTTPException(status_code=response.status_code, detail="Lightspeed token exchange failed")
        payload = response.json()
        expires_in = payload.get("expires_in", 1800)
        payload["expires_at"] = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
        return payload

    def upsert_token(
        self,
        db: Session,
        *,
        user_id: uuid.UUID,
        account_id: str,
        access_token: str,
        refresh_token: str,
        expires_at: datetime,
        scopes: Optional[str] = None,
    ) -> LightspeedToken:
        token = db.query(LightspeedToken).filter(LightspeedToken.user_id == user_id).one_or_none()
        if token:
            token.account_id = account_id
            token.access_token = access_token
            token.refresh_token = refresh_token
            token.expires_at = expires_at
            token.scopes = scopes
        else:
            token = LightspeedToken(
                user_id=user_id,
                account_id=account_id,
                access_token=access_token,
                refresh_token=refresh_token,
                expires_at=expires_at,
                scopes=scopes,
            )
            db.add(token)
        db.commit()
        db.refresh(token)
        return token

    def get_token(self, db: Session, user_id: uuid.UUID) -> Optional[LightspeedToken]:
        return db.query(LightspeedToken).filter(LightspeedToken.user_id == user_id).one_or_none()


lightspeed_service = LightspeedService()
