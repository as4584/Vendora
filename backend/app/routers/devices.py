"""Register/unregister this device for push alerts (eBay sales)."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.push_token import PushToken
from app.models.user import User
from app.services.push import is_expo_token

router = APIRouter(prefix="/devices", tags=["devices"])


class PushTokenIn(BaseModel):
    token: str = Field(min_length=10, max_length=255)
    platform: Optional[str] = Field(default=None, max_length=16)


@router.post("/push-token", status_code=status.HTTP_204_NO_CONTENT)
def register_push_token(
    body: PushTokenIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not is_expo_token(body.token):
        raise HTTPException(status_code=422, detail={"error": "invalid_push_token"})
    row = db.query(PushToken).filter(PushToken.token == body.token).one_or_none()
    if row:
        # A device that changes accounts follows the latest sign-in.
        row.user_id = current_user.id
        row.platform = body.platform
    else:
        db.add(
            PushToken(user_id=current_user.id, token=body.token, platform=body.platform)
        )
    db.commit()


@router.post("/push-token/remove", status_code=status.HTTP_204_NO_CONTENT)
def unregister_push_token(
    body: PushTokenIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    db.query(PushToken).filter(
        PushToken.token == body.token, PushToken.user_id == current_user.id
    ).delete()
    db.commit()
