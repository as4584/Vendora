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
    # Password reset email (SendGrid)
    SENDGRID_API: str = ""
    SENDGRID_FROM_EMAIL: str = "noreply@lexmakesit.com"
    SENDGRID_FROM_NAME: str = "Vendora"
    PASSWORD_RESET_URL: str = "vendora://reset-password"
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
    # Provider token encryption key (Fernet — 32-byte URL-safe base64).
    # Generate: python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # If empty, a key is derived from SECRET_KEY via SHA-256 (acceptable for dev/test).
    PROVIDER_TOKEN_KEY: str = ""
    # Square webhook signature key for HMAC-SHA256 verification.
    # Set to the Signature Key shown in the Square Developer Console for your webhook endpoint.
    SQUARE_WEBHOOK_SIGNATURE_KEY: str = ""
    SQUARE_WEBHOOK_URL: str = ""

settings = Settings()
