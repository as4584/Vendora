"""Integration-related schemas."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, HttpUrl


class LightspeedAuthURLResponse(BaseModel):
    authorization_url: HttpUrl


class LightspeedConnectResponse(BaseModel):
    message: str


class LightspeedSyncResponse(BaseModel):
    """Response for POST /integrations/lightspeed/sync.

    Matches SyncResult fields plus a string status for backward compat.
    run_id is new (additive) — mobile callers may ignore it.
    """

    status: str = "completed"
    run_id: uuid.UUID
    items_imported: int = 0
    items_updated: int = 0
    items_skipped: int = 0
    transactions_imported: int = 0
    transactions_updated: int = 0
    errors_count: int = 0


class LightspeedPushResponse(BaseModel):
    status: str = "completed"
    items_created: int = 0
    items_updated: int = 0
    errors_count: int = 0


class LightspeedDisconnectResponse(BaseModel):
    disconnected: bool
    links_retained: int


class ProviderSyncRunResponse(BaseModel):
    """Response for GET /integrations/sync-runs and GET /integrations/sync-runs/{run_id}."""

    model_config = {"from_attributes": True}

    id: uuid.UUID
    provider: str
    user_id: uuid.UUID
    account_id: Optional[str]
    started_at: datetime
    completed_at: Optional[datetime]
    status: str
    trigger_type: str = "manual"
    items_imported: int
    items_updated: int
    items_skipped: int
    transactions_imported: int
    transactions_updated: int
    errors_count: int
    error_message: Optional[str]


class ReconciliationIssueResponse(BaseModel):
    """Response for GET /integrations/reconciliation-issues."""

    model_config = {"from_attributes": True}

    id: uuid.UUID
    provider: str
    user_id: uuid.UUID
    inventory_item_id: Optional[uuid.UUID]
    sync_run_id: Optional[uuid.UUID]
    external_id: Optional[str]
    issue_type: str
    severity: str
    status: str
    details: Optional[dict]
    detected_at: datetime
    resolved_at: Optional[datetime]
    resolution_note: Optional[str] = None


class ReconciliationIssueUpdateRequest(BaseModel):
    """Request body for PATCH /integrations/reconciliation-issues/{issue_id}."""

    status: str  # resolved | dismissed
    resolution_note: Optional[str] = None


# ─── Square schemas ───────────────────────────────────────────────────────────

class SquareConnectRequest(BaseModel):
    """Request body for POST /integrations/square/connect."""

    access_token: str
    # Square merchant ID — optional; resolved automatically on first sync if omitted
    merchant_id: Optional[str] = None
    # Restrict inventory counts to this Square location ID (optional)
    location_id: Optional[str] = None


class SquareConnectResponse(BaseModel):
    """Response for POST /integrations/square/connect."""

    message: str
    merchant_id: Optional[str]
    location_id: Optional[str]


class SquareStatusResponse(BaseModel):
    """Response for GET /integrations/square/status."""

    connected: bool
    merchant_id: Optional[str]
    location_id: Optional[str]
    last_synced_at: Optional[str]


class SquareSyncResponse(BaseModel):
    """Response for POST /integrations/square/sync.

    Field layout mirrors LightspeedSyncResponse for UI consistency.
    """

    status: str = "completed"
    run_id: uuid.UUID
    items_imported: int = 0
    items_updated: int = 0
    items_skipped: int = 0
    transactions_imported: int = 0
    transactions_updated: int = 0
    errors_count: int = 0


# ─── Clover schemas ───────────────────────────────────────────────────────────

class CloverConnectRequest(BaseModel):
    """Request body for POST /integrations/clover/connect.

    merchant_id is required for Clover (every API call includes it in the path).
    """

    merchant_id: str
    access_token: str


class CloverConnectResponse(BaseModel):
    """Response for POST /integrations/clover/connect."""

    message: str
    merchant_id: str


class CloverStatusResponse(BaseModel):
    """Response for GET /integrations/clover/status."""

    connected: bool
    merchant_id: Optional[str]
    last_synced_at: Optional[str]


class CloverSyncResponse(BaseModel):
    """Response for POST /integrations/clover/sync.

    Field layout mirrors LightspeedSyncResponse and SquareSyncResponse.
    """

    status: str = "completed"
    run_id: uuid.UUID
    items_imported: int = 0
    items_updated: int = 0
    items_skipped: int = 0
    transactions_imported: int = 0
    transactions_updated: int = 0
    errors_count: int = 0


# ─── Production hardening schemas ────────────────────────────────────────────

class WebhookEventResponse(BaseModel):
    """Response for webhook event log."""

    model_config = {"from_attributes": True}

    id: uuid.UUID
    provider: str
    user_id: Optional[uuid.UUID]
    event_id: str
    event_type: str
    received_at: datetime
    processed: bool
    sync_run_id: Optional[uuid.UUID]
    error: Optional[str]


class SyncRetryResponse(BaseModel):
    """Response for POST /integrations/sync-runs/{run_id}/retry."""

    message: str
    new_run_id: uuid.UUID
    status: str
    items_imported: int = 0
    items_updated: int = 0
    errors_count: int = 0


class ProviderHealthEntry(BaseModel):
    """Per-provider health summary."""

    provider: str
    last_run_at: Optional[datetime]
    last_run_status: Optional[str]
    failed_runs_24h: int
    open_issues_count: int


class ProviderHealthResponse(BaseModel):
    """Response for GET /integrations/health."""

    providers: list[ProviderHealthEntry]
