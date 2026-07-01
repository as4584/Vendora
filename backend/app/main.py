"""Vendora API — FastAPI application entrypoint."""
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from alembic.config import Config
from alembic import command as alembic_command

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.middleware import SlowAPIMiddleware
from slowapi.errors import RateLimitExceeded

from app.routers import auth, inventory, transactions, dashboard, invoices, webhooks
from app.routers import export, features, sellers, integrations
from app.routers import subscriptions, support
from app.config import settings
from app.rate_limit import limiter

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Validate production security and migrate the database before serving."""
    if settings.ENVIRONMENT == "production" and (
        settings.SECRET_KEY == "change-me-to-a-secure-random-string"
        or len(settings.SECRET_KEY) < 32
    ):
        raise RuntimeError("Production SECRET_KEY must be a unique value of at least 32 characters.")

    if settings.ENVIRONMENT != "testing":
        alembic_path = Path(__file__).resolve().parents[1] / "alembic.ini"
        alembic_cfg = Config(str(alembic_path))
        alembic_command.upgrade(alembic_cfg, "head")
        logger.info("Alembic migrations applied.")
    yield

app = FastAPI(
    title="Vendora API",
    description="Reseller Operating System — Inventory + Payments + Profit + Trust",
    version="4.2.0",
    docs_url="/api/v1/docs",
    redoc_url="/api/v1/redoc",
    openapi_url="/api/v1/openapi.json",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:19006",
    "http://127.0.0.1:19006",
    "http://localhost:8081",
    "http://127.0.0.1:8081",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

_allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGIN", "").split(",") if o.strip()]

# CORS — allow mobile app to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins or DEFAULT_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers under /api/v1
app.include_router(auth.router, prefix="/api/v1")
app.include_router(inventory.router, prefix="/api/v1")
app.include_router(transactions.router, prefix="/api/v1")
app.include_router(dashboard.router, prefix="/api/v1")
app.include_router(invoices.router, prefix="/api/v1")
app.include_router(webhooks.router, prefix="/api/v1")
app.include_router(export.router, prefix="/api/v1")
app.include_router(features.router, prefix="/api/v1")
app.include_router(sellers.router, prefix="/api/v1")
app.include_router(integrations.router, prefix="/api/v1")
app.include_router(subscriptions.router, prefix="/api/v1")
app.include_router(support.router, prefix="/api/v1")


@app.get("/api/v1/health", tags=["health"])
def health_check():
    """Health check endpoint."""
    return {"status": "ok", "version": "4.2.0"}
# trigger reload
