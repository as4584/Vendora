"""Pydantic schemas for User auth endpoints."""
import re
import base64
import binascii
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PROFILE_IMAGE_PATTERN = re.compile(
    r"^data:image/(?P<format>jpeg|jpg|png|webp);base64,(?P<data>[A-Za-z0-9+/=\s]+)$",
    re.IGNORECASE,
)
MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024

def _normalize_email(value: str) -> str:
    normalized = str(value).strip().lower()
    if len(normalized) > 255 or not _EMAIL_PATTERN.fullmatch(normalized):
        raise ValueError("Enter a valid email address")
    return normalized


def _validate_profile_picture(value: str | None) -> str | None:
    if value is None:
        return None
    match = _PROFILE_IMAGE_PATTERN.fullmatch(value)
    if not match:
        raise ValueError("Profile picture must be a JPEG, PNG, or WebP data URL")
    try:
        decoded = base64.b64decode(match.group("data"), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Profile picture contains invalid base64 data") from exc
    if len(decoded) > MAX_PROFILE_IMAGE_BYTES:
        raise ValueError("Profile picture must be 5 MB or smaller")
    return value


class UserCreate(BaseModel):
    email: str = Field(..., max_length=255, description="User email address")
    password: str = Field(..., min_length=8, max_length=128, description="User password")
    business_name: str | None = Field(None, max_length=255)

    _normalize = field_validator("email", mode="before")(_normalize_email)


class UserLogin(BaseModel):
    email: str = Field(..., max_length=255)
    password: str = Field(..., min_length=1, max_length=128)

    _normalize = field_validator("email", mode="before")(_normalize_email)


class PasswordResetRequest(BaseModel):
    email: str = Field(..., max_length=255)

    _normalize = field_validator("email", mode="before")(_normalize_email)


class PasswordResetConfirm(BaseModel):
    token: str = Field(..., min_length=32, max_length=512)
    password: str = Field(..., min_length=8, max_length=128)


class MessageResponse(BaseModel):
    message: str


class RefreshTokenRequest(BaseModel):
    refresh_token: str = Field(..., min_length=32, max_length=512)


class AccountDeleteRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=128)
    confirmation: str

    @field_validator("confirmation")
    @classmethod
    def confirmation_must_match(cls, value: str) -> str:
        if value != "DELETE":
            raise ValueError('Enter "DELETE" to confirm account deletion')
        return value


class UserResponse(BaseModel):
    id: UUID
    email: str
    business_name: str | None
    profile_picture: str | None = None
    business_address: str | None = None
    business_phone: str | None = None
    invoice_accent_color: str | None = None
    subscription_tier: str
    is_partner: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _validate_accent_color(value: str | None) -> str | None:
    if value is None or value == "":
        return value
    if not _HEX_COLOR.match(value):
        raise ValueError("invoice_accent_color must be a hex color like #3B7BDB")
    return value


class UserProfileUpdate(BaseModel):
    business_name: str | None = Field(None, max_length=255)
    profile_picture: str | None = None  # base64 data URL, e.g. 'data:image/jpeg;base64,...'
    business_address: str | None = Field(None, max_length=500)
    business_phone: str | None = Field(None, max_length=40)
    invoice_accent_color: str | None = None  # hex, e.g. #3B7BDB

    _validate_picture = field_validator("profile_picture", mode="before")(_validate_profile_picture)
    _validate_accent = field_validator("invoice_accent_color", mode="before")(_validate_accent_color)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
