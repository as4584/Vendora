"""Reset the management tester account password.

Run from the backend directory:
    VENDORA_MANAGEMENT_PASSWORD=... python reset_management_password.py

If VENDORA_MANAGEMENT_PASSWORD is unset, the password is prompted for
without echo. Never hardcode it here: this repository is public.
"""

from __future__ import annotations

import getpass
import os

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.user import User
from app.services.auth import hash_password
from app.services.tester_access import apply_tester_entitlements


TARGET_EMAIL = "management.donxera@gmail.com"
MIN_PASSWORD_LENGTH = 12


def reset_account_password(
    db: Session,
    password: str,
    email: str = TARGET_EMAIL,
) -> User:
    """Create or update the target account with a freshly hashed password."""
    normalized_email = email.strip().lower()
    user = db.query(User).filter(User.email == normalized_email).first()

    if user is None:
        user = User(email=normalized_email)
        db.add(user)

    user.password_hash = hash_password(password)
    apply_tester_entitlements(user)
    db.commit()
    db.refresh(user)
    return user


def _read_password() -> str:
    password = os.environ.get("VENDORA_MANAGEMENT_PASSWORD") or getpass.getpass("New password: ")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise SystemExit(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    return password


def main() -> None:
    password = _read_password()
    db = SessionLocal()
    try:
        user = reset_account_password(db, password)
        print(f"Reset password for {user.email}.")
        print(f"subscription_tier={user.subscription_tier} is_partner={user.is_partner}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
