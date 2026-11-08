"""Auth dependency — extracts and validates current user from JWT."""
import uuid
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.auth_session import AuthSession
from app.services.auth import decode_access_token
from app.services.tester_access import persist_tester_entitlements

security = HTTPBearer()


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    """FastAPI dependency: decode JWT, load user, enforce active (non-deleted)."""
    token = credentials.credentials
    payload = decode_access_token(token)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token.",
        )

    user_id = payload.get("sub")
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload.",
        )

    # Every access token the API issues is bound to a revocable AuthSession.
    # A token without one could not be revoked by logout or password reset,
    # so it is refused.
    session_id = payload.get("sid")
    if session_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload.",
        )
    try:
        session_id = uuid.UUID(str(session_id))
        user_id = uuid.UUID(str(user_id))
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload.",
        )
    session = (
        db.query(AuthSession)
        .filter(
            AuthSession.id == session_id,
            AuthSession.user_id == user_id,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > datetime.now(timezone.utc),
        )
        .first()
    )
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session has expired or been revoked.",
        )

    user = (
        db.query(User)
        .filter(User.id == user_id, User.deleted_at.is_(None))
        .first()
    )
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or account deleted.",
        )

    return persist_tester_entitlements(db, user)
