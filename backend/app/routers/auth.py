"""Auth router — /api/v1/auth endpoints."""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.auth_session import AuthSession
from app.schemas.user import (
    MessageResponse,
    AccountDeleteRequest,
    PasswordResetConfirm,
    PasswordResetRequest,
    RefreshTokenRequest,
    TokenResponse,
    UserCreate,
    UserLogin,
    UserProfileUpdate,
    UserResponse,
)
from app.services.auth import (
    create_access_token,
    create_password_reset_token,
    hash_password,
    hash_password_reset_token,
    hash_refresh_token,
    issue_session,
    revoke_all_sessions,
    rotate_session,
    verify_password,
)
from app.services.email import EmailDeliveryError, send_password_reset_email
from app.rate_limit import limiter
from app.services.tester_access import apply_tester_entitlements, persist_tester_entitlements
from app.dependencies.auth import get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)
RESET_REQUEST_MESSAGE = (
    "If an account exists for that email, a password reset link has been sent."
)


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(payload: UserCreate, db: Session = Depends(get_db)):
    """Register a new user account."""
    # Check duplicate email
    existing = (
        db.query(User)
        .filter(func.lower(User.email) == str(payload.email), User.deleted_at.is_(None))
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists.",
        )

    user = User(
        email=str(payload.email),
        password_hash=hash_password(payload.password),
        business_name=payload.business_name,
    )
    apply_tester_entitlements(user)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
def login(payload: UserLogin, request: Request, db: Session = Depends(get_db)):
    """Authenticate and return JWT access token."""
    user = (
        db.query(User)
        .filter(func.lower(User.email) == str(payload.email), User.deleted_at.is_(None))
        .first()
    )
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    user = persist_tester_entitlements(db, user)
    access_token, refresh_token, _ = issue_session(
        db, user.id, request.headers.get("user-agent")
    )
    db.commit()
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/refresh", response_model=TokenResponse)
@limiter.limit("30/minute")
def refresh_session(
    payload: RefreshTokenRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    rotated = rotate_session(db, payload.refresh_token)
    if rotated is None:
        raise HTTPException(status_code=401, detail="Refresh token is invalid or expired.")
    access_token, refresh_token, _ = rotated
    db.commit()
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/logout", response_model=MessageResponse)
def logout(payload: RefreshTokenRequest, db: Session = Depends(get_db)):
    session = db.query(AuthSession).filter(
        AuthSession.refresh_token_hash == hash_refresh_token(payload.refresh_token)
    ).first()
    if session and session.revoked_at is None:
        session.revoked_at = datetime.now(timezone.utc)
        db.commit()
    return MessageResponse(message="Signed out.")


@router.post(
    "/forgot-password",
    response_model=MessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
@limiter.limit("5/minute")
def forgot_password(
    payload: PasswordResetRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Email a one-time reset link without revealing whether the account exists."""
    normalized_email = payload.email.strip().lower()
    user = (
        db.query(User)
        .filter(
            func.lower(User.email) == normalized_email,
            User.deleted_at.is_(None),
        )
        .first()
    )
    if not user:
        return MessageResponse(message=RESET_REQUEST_MESSAGE)

    token, token_hash, expires_at = create_password_reset_token()
    user.password_reset_token_hash = token_hash
    user.password_reset_expires_at = expires_at
    db.add(user)
    db.commit()

    try:
        send_password_reset_email(user.email, token)
    except EmailDeliveryError:
        # Preserve the same public response for existing and unknown accounts.
        logger.exception("Password reset email delivery failed")

    return MessageResponse(message=RESET_REQUEST_MESSAGE)


@router.post("/reset-password", response_model=MessageResponse)
def reset_password(payload: PasswordResetConfirm, db: Session = Depends(get_db)):
    """Consume a valid one-time token and replace the user's password."""
    token_hash = hash_password_reset_token(payload.token)
    user = (
        db.query(User)
        .filter(
            User.password_reset_token_hash == token_hash,
            User.deleted_at.is_(None),
        )
        .first()
    )
    now = datetime.now(timezone.utc)
    expires_at = user.password_reset_expires_at if user else None
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if not user or not expires_at or expires_at <= now:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This password reset link is invalid or has expired.",
        )

    user.password_hash = hash_password(payload.password)
    user.password_reset_token_hash = None
    user.password_reset_expires_at = None
    revoke_all_sessions(db, user.id)
    db.add(user)
    db.commit()
    return MessageResponse(message="Your password has been reset. You can now sign in.")


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    """Return current authenticated user profile."""
    return current_user


@router.patch("/profile", response_model=UserResponse)
def update_profile(
    payload: UserProfileUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update business name, profile picture (base64 data URL), and invoice branding."""
    if payload.business_name is not None:
        current_user.business_name = payload.business_name
    if payload.profile_picture is not None:
        current_user.profile_picture = payload.profile_picture
    if payload.business_address is not None:
        current_user.business_address = payload.business_address
    if payload.business_phone is not None:
        current_user.business_phone = payload.business_phone
    if payload.invoice_accent_color is not None:
        current_user.invoice_accent_color = payload.invoice_accent_color
    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    return current_user


@router.delete("/account", response_model=MessageResponse)
def delete_account(
    payload: AccountDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete the account and user-owned data through DB cascades."""
    if not verify_password(payload.password, current_user.password_hash):
        raise HTTPException(status_code=401, detail="Password is incorrect.")
    db.delete(current_user)
    db.commit()
    return MessageResponse(message="Account permanently deleted.")
