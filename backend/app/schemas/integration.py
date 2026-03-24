"""Integration-related schemas."""
from pydantic import BaseModel, HttpUrl


class LightspeedAuthURLResponse(BaseModel):
    authorization_url: HttpUrl


class LightspeedConnectResponse(BaseModel):
    message: str


class LightspeedSyncResponse(BaseModel):
    status: str = "completed"
    items_imported: int = 0
    items_updated: int = 0
    transactions_imported: int = 0
    transactions_updated: int = 0
