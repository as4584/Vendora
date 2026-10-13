from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "postgresql://vendora:vendora@localhost:5432/vendora"
    TEST_DATABASE_URL: str = "postgresql://vendora:vendora@localhost:5433/vendora_test"
    SECRET_KEY: str = "change-me-to-a-secure-random-string"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    ALGORITHM: str = "HS256"
    ENVIRONMENT: str = "development"
    ALLOWED_ORIGIN: str = "http://localhost:3000,http://localhost:8081"
    PUBLIC_API_BASE_URL: str = "http://localhost:8000/api/v1"
    TESTER_EMAIL_ALLOWLIST: str = "management.donxera@gmail.com"
    # Transactional email. Resend is the production provider. SMTP is an
    # optional fallback, used instead of Resend only when SMTP_HOST is set;
    # production leaves it empty. See docs/EMAIL_DELIVERY.md.
    RESEND_API_KEY: str = ""
    SMTP_HOST: str = ""
    SMTP_PORT: int = 465
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_USE_TLS: bool = False
    EMAIL_FROM_EMAIL: str = "noreply@lexmakesit.com"
    EMAIL_FROM_NAME: str = "Vendora"
    # Discord webhook — in-app support requests are mirrored to the team channel.
    DISCORD_WEBHOOK_URL: str = ""
    # HTTPS keeps reset links clickable in Gmail; the bridge page served by
    # app/routers/reset_bridge.py opens the app's vendora:// reset screen.
    PASSWORD_RESET_URL: str = "https://vendora.lexmakesit.com/reset-password"
    PASSWORD_RESET_TOKEN_EXPIRE_MINUTES: int = 30
    INTEGRATION_SUCCESS_URL: str = "vendora://settings?integration=lightspeed&status=connected"
    # Stripe
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PRO_PRICE_ID: str = ""  # Stripe Price ID for Pro tier ($20/mo)
    STRIPE_PARTNER_PRICE_ID: str = ""  # Stripe Price ID for Partner add-on ($5/mo)
    SUPPORT_EMAIL: str = "support@lexmakesit.com"
    # Lightspeed Retail (R-Series)
    LIGHTSPEED_CLIENT_ID: str = ""
    LIGHTSPEED_CLIENT_SECRET: str = ""
    LIGHTSPEED_REDIRECT_URI: str = "http://localhost:8000/integrations/lightspeed/callback"
    # eBay Sell APIs (pull-only integration). Switch sandbox/production via EBAY_ENV.
    EBAY_CLIENT_ID: str = ""        # App ID (Client ID) from the eBay developer portal
    EBAY_CLIENT_SECRET: str = ""    # Cert ID (Client Secret)
    EBAY_RUNAME: str = ""           # Redirect URL name (RuName) — used as redirect_uri in OAuth
    EBAY_ENV: str = "sandbox"       # "sandbox" | "production"
    # Marketplace Account Deletion compliance (required to enable a production keyset).
    # EBAY_VERIFICATION_TOKEN is a self-chosen 32–80 char string entered in the eBay portal.
    # EBAY_DELETION_ENDPOINT must EXACTLY match the endpoint URL configured there (used in the hash).
    EBAY_VERIFICATION_TOKEN: str = ""
    EBAY_DELETION_ENDPOINT: str = "https://vendora.lexmakesit.com/api/v1/integrations/ebay/deletion"
    # StockX (market data / last-sale lookups). Creds live in Doppler `api-keys`.
    STOCKX_API_KEY: str = ""
    STOCKX_CLIENT_ID: str = ""
    STOCKX_CLIENT_SECRET: str = ""
    STOCKX_REDIRECT_URI: str = "https://vendora.lexmakesit.com/api/v1/integrations/stockx/callback"

    # Sync endpoints run on AnyIO's 40-thread pool. The DB pool must hold at least
    # that many connections, or threads waiting for a connection starve the
    # requests that hold one and the whole API deadlocks under load.
    DB_POOL_SIZE: int = 20
    DB_MAX_OVERFLOW: int = 30
    DB_POOL_TIMEOUT: int = 10
    # Requests one process works on at once (app/request_limit.py). Must not
    # exceed DB_POOL_SIZE + DB_MAX_OVERFLOW; extra requests queue, then get 503.
    MAX_IN_FLIGHT_REQUESTS: int = 40
    REQUEST_QUEUE_TIMEOUT: float = 10.0
    # Redis backs the background job queue (app/jobs.py) and rate-limit counters
    # shared by every API process. Empty: jobs run inline, limits are per process.
    REDIS_URL: str = ""
    # With several API replicas, a one-shot `migrate` service applies migrations
    # once before they start (docker-compose.prod.yml), so replicas skip it.
    RUN_MIGRATIONS_ON_STARTUP: bool = True
    # Provider token encryption key (Fernet — 32-byte URL-safe base64).
    # Generate: python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # If empty, a key is derived from SECRET_KEY via SHA-256 (acceptable for dev/test).
    PROVIDER_TOKEN_KEY: str = ""
    # Square webhook signature key for HMAC-SHA256 verification.
    # Set to the Signature Key shown in the Square Developer Console for your webhook endpoint.
    SQUARE_WEBHOOK_SIGNATURE_KEY: str = ""
    SQUARE_WEBHOOK_URL: str = ""
    @model_validator(mode="after")
    def _require_https_reset_link(self):
        # Mail apps strip custom-scheme links (vendora://), leaving reset
        # emails with nothing to tap. Production must use the HTTPS bridge page.
        if self.ENVIRONMENT == "production" and not self.PASSWORD_RESET_URL.startswith("https://"):
            raise ValueError("PASSWORD_RESET_URL must be an https:// URL in production")
        return self


settings = Settings()
