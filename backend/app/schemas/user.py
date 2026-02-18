"""Pydantic schemas for User auth endpoints."""
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


class UserCreate(BaseModel):
    email: str = Field(..., max_length=255, description="User email address")
    password: str = Field(..., min_length=8, max_length=128, description="User password")
    business_name: str | None = Field(None, max_length=255)


class UserLogin(BaseModel):
    email: str = Field(..., max_length=255)
    password: str = Field(..., min_length=1, max_length=128)


class UserResponse(BaseModel):
    id: UUID
    email: str
    business_name: str | None
    subscription_tier: str
    is_partner: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
