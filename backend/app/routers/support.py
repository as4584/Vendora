"""Authenticated in-app customer support."""
import logging

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.support import SupportRequest
from app.models.user import User
from app.services.discord import DiscordNotifyError, send_support_notification
from app.services.email import EmailDeliveryError, send_support_request_email

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/support", tags=["support"])


class SupportRequestCreate(BaseModel):
    subject: str = Field(min_length=3, max_length=160)
    message: str = Field(min_length=10, max_length=5000)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_support_request(
    body: SupportRequestCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    priority = "priority" if current_user.is_partner else "standard"
    ticket = SupportRequest(
        user_id=current_user.id,
        subject=body.subject.strip(),
        message=body.message.strip(),
        priority=priority,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)
    discord_notified = True
    try:
        send_support_notification(current_user.email, ticket.subject, ticket.message, priority)
    except DiscordNotifyError:
        discord_notified = False
        logger.exception("Support Discord notification failed for ticket %s", ticket.id)
    email_queued = True
    try:
        send_support_request_email(current_user.email, ticket.subject, ticket.message, priority)
    except EmailDeliveryError:
        email_queued = False
        logger.exception("Support email delivery failed for ticket %s", ticket.id)
    return {
        "id": str(ticket.id),
        "status": ticket.status,
        "priority": priority,
        "email_queued": email_queued,
        "discord_notified": discord_notified,
    }
