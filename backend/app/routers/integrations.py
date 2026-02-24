"""3rd-party integrations (Lightspeed, Clover, etc.)."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.schemas.integration import (
    LightspeedAuthURLResponse,
    LightspeedConnectResponse,
    LightspeedSyncResponse,
)
from app.services.lightspeed import lightspeed_service

router = APIRouter(prefix="/integrations", tags=["integrations"])


@router.get("/lightspeed/status")
def lightspeed_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Returns whether the current user has connected their Lightspeed account."""
    token = lightspeed_service.get_token(db, current_user.id)
    if not token:
        return {"connected": False, "account_id": None, "expires_at": None}
    return {
        "connected": True,
        "account_id": token.account_id,
        "expires_at": token.expires_at.isoformat(),
    }


@router.get("/lightspeed/connect", response_model=LightspeedAuthURLResponse)
async def lightspeed_connect(current_user: User = Depends(get_current_user)):
    """Return the OAuth URL so the reseller can authorize Vendora."""
    state = lightspeed_service.build_state(current_user.id)
    return LightspeedAuthURLResponse(authorization_url=lightspeed_service.authorization_url(state))


@router.get("/lightspeed/callback", response_model=LightspeedConnectResponse)
async def lightspeed_callback(code: str, state: str, db: Session = Depends(get_db)):
    """Handle Lightspeed OAuth callback and persist tokens."""
    user_id = lightspeed_service.parse_state(state)
    token_payload = await lightspeed_service.exchange_authorization_code(code)
    account_id = str(token_payload.get("account_id"))
    if not account_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Lightspeed response missing account_id")

    lightspeed_service.upsert_token(
        db,
        user_id=user_id,
        account_id=account_id,
        access_token=token_payload["access_token"],
        refresh_token=token_payload.get("refresh_token", ""),
        expires_at=token_payload["expires_at"],
        scopes=token_payload.get("scope"),
    )
    return LightspeedConnectResponse(message="Lightspeed account connected.")


@router.post("/lightspeed/sync", response_model=LightspeedSyncResponse)
async def lightspeed_sync(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One-way sync: pull latest inventory and sales from Lightspeed into Vendora."""
    result = await lightspeed_service.sync(db, current_user.id)
    return LightspeedSyncResponse(
        status="completed",
        items_imported=result["items_imported"],
        items_updated=result["items_updated"],
        transactions_imported=result["transactions_imported"],
        transactions_updated=result["transactions_updated"],
    )
