"""Helpers for granting elevated access to internal tester accounts."""
from sqlalchemy.orm import Session

from app.config import settings
from app.models.user import User


def _allowed_tester_emails() -> set[str]:
    return {
        email.strip().lower()
        for email in settings.TESTER_EMAIL_ALLOWLIST.split(",")
        if email.strip()
    }


def is_tester_email(email: str | None) -> bool:
    if not email:
        return False
    return email.strip().lower() in _allowed_tester_emails()


def apply_tester_entitlements(user: User) -> bool:
    """Grant the highest in-app access level to allowlisted tester accounts."""
    if not is_tester_email(user.email):
        return False

    changed = False
    if user.subscription_tier != "pro":
        user.subscription_tier = "pro"
        changed = True
    if not user.is_partner:
        user.is_partner = True
        changed = True
    return changed


def persist_tester_entitlements(db: Session, user: User) -> User:
    """Persist tester entitlements when a matching account is loaded from the DB."""
    if apply_tester_entitlements(user):
        db.add(user)
        db.commit()
        db.refresh(user)
    return user
