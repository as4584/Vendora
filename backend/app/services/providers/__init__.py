"""Provider adapter package.

Public exports:
  - ProviderAdapter   ABC that all provider sync adapters implement
  - SyncResult        Canonical sync result dataclass (returned by every adapter)
  - SyncRunManager    CRUD helpers for ProviderSyncRun lifecycle
"""
from app.services.providers.base import ProviderAdapter, SyncResult, SyncRunManager

__all__ = ["ProviderAdapter", "SyncResult", "SyncRunManager"]
