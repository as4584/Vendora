"""Integration-related schemas."""
from pydantic import BaseModel, HttpUrl


class LightspeedAuthURLResponse(BaseModel):
    authorization_url: HttpUrl


class LightspeedConnectResponse(BaseModel):
    message: str


class LightspeedSyncResponse(BaseModel):
    status: str = "scheduled"
    items_imported: int = 0
    transactions_imported: int = 0
