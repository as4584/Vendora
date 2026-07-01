"""Auth service — password hashing and token operations."""
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from jwt.exceptions import InvalidTokenError as JWTError
from passlib.context import CryptContext

from app.config import settings
from app.models.auth_session import AuthSession

pwd_context = CryptContext(
    schemes=["bcrypt"],
    deprecated="auto",
    bcrypt__rounds=12,
    bcrypt__ident="2b",
    bcrypt__truncate_error=True,
)


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plain password against its bcrypt hash."""
    return pwd_context.verify(plain_password, hashed_password)


def create_password_reset_token() -> tuple[str, str, datetime]:
    """Create a random one-time token, its database-safe hash, and expiry."""
    token = secrets.token_urlsafe(48)
    return (
        token,
        hash_password_reset_token(token),
        datetime.now(timezone.utc)
        + timedelta(minutes=settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES),
    )


def hash_password_reset_token(token: str) -> str:
    """Hash a reset token so the usable token is never stored in the database."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    """Create a JWT access token."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire, "typ": "access"})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    """Decode and validate a JWT access token. Returns payload or None."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        if payload.get("typ") not in {None, "access"}:
            return None
        return payload
    except JWTError:
        return None


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_session(db, user_id, user_agent: str | None = None) -> tuple[str, str, AuthSession]:
    """Create a revocable session and return its access and refresh credentials."""
    refresh_token = secrets.token_urlsafe(64)
    session = AuthSession(
        id=uuid.uuid4(),
        user_id=user_id,
        refresh_token_hash=hash_refresh_token(refresh_token),
        expires_at=datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        user_agent=(user_agent or "")[:255] or None,
    )
    db.add(session)
    db.flush()
    access_token = create_access_token({"sub": str(user_id), "sid": str(session.id)})
    return access_token, refresh_token, session


def rotate_session(db, refresh_token: str) -> tuple[str, str, AuthSession] | None:
    """Atomically rotate a valid refresh token and issue a new access token."""
    now = datetime.now(timezone.utc)
    session = (
        db.query(AuthSession)
        .filter(
            AuthSession.refresh_token_hash == hash_refresh_token(refresh_token),
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
        )
        .with_for_update()
        .first()
    )
    if session is None:
        return None
    next_refresh = secrets.token_urlsafe(64)
    session.refresh_token_hash = hash_refresh_token(next_refresh)
    session.expires_at = now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    access_token = create_access_token({"sub": str(session.user_id), "sid": str(session.id)})
    return access_token, next_refresh, session


def revoke_all_sessions(db, user_id) -> None:
    db.query(AuthSession).filter(
        AuthSession.user_id == user_id,
        AuthSession.revoked_at.is_(None),
    ).update({AuthSession.revoked_at: datetime.now(timezone.utc)}, synchronize_session=False)
