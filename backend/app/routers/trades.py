"""Trades router — /api/v1/trades

    POST /trades   — record a swap (pairs out, pairs in, cash either way)
    GET  /trades   — recent trades
"""
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies.auth import get_current_user
from app.models.user import User
from app.schemas.trade import TradeCreate, TradeResponse
from app.services.trades import list_trades, record_trade

router = APIRouter(prefix="/trades", tags=["trades"])


@router.post("", response_model=TradeResponse, status_code=status.HTTP_201_CREATED)
def create_trade(payload: TradeCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Record a trade atomically. Replays with the same client_request_id return the original."""
    return record_trade(db, current_user.id, payload)


@router.get("", response_model=list[TradeResponse])
def get_trades(
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return list_trades(db, current_user.id, limit)
