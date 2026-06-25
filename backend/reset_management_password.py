"""Reset the management tester account password.

Run from the backend directory:
    python reset_management_password.py
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.user import User
from app.services.auth import hash_password
from app.services.tester_access import apply_tester_entitlements


TARGET_EMAIL = "management.donxera@gmail.com"
TARGET_PASSWORD = "password123"


def reset_account_password(
    db: Session,
    email: str = TARGET_EMAIL,
    password: str = TARGET_PASSWORD,
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


def main() -> None:
    db = SessionLocal()
    try:
        user = reset_account_password(db)
        print(f"Reset password for {user.email}.")
        print(f"subscription_tier={user.subscription_tier} is_partner={user.is_partner}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
