"""First-party analytics: the app posts funnel events; the owner reads the funnel."""

import hmac
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.rate_limit import limiter
from app.services import analytics

router = APIRouter(prefix="/events", tags=["analytics"])


class EventIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    props: Optional[dict[str, Any]] = None


@router.post("", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("120/minute")
def record_event(
    request: Request,
    body: EventIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if body.name not in analytics.CLIENT_EVENTS:
        raise HTTPException(status_code=422, detail={"error": "unknown_event"})
    analytics.track(db, current_user.id, body.name, body.props)
    db.commit()


@router.get("/funnel")
def get_funnel(
    days: int = 30,
    x_analytics_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    expected = settings.ANALYTICS_ADMIN_TOKEN
    if not expected or not hmac.compare_digest(x_analytics_token, expected):
        raise HTTPException(status_code=404)
    return analytics.funnel(db, max(1, min(days, 365)))
