from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql://vendora:vendora@localhost:5432/vendora"
    TEST_DATABASE_URL: str = "postgresql://vendora:vendora@localhost:5433/vendora_test"
    SECRET_KEY: str = "change-me-to-a-secure-random-string"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    ALGORITHM: str = "HS256"
    ENVIRONMENT: str = "development"
    ALLOWED_ORIGIN: str = "http://localhost:3000,http://localhost:8081"
    PUBLIC_API_BASE_URL: str = "http://localhost:8000/api/v1"
    TESTER_EMAIL_ALLOWLIST: str = "management.donxera@gmail.com"
    # Stripe
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PRO_PRICE_ID: str = ""  # Stripe Price ID for Pro tier ($20/mo)
    # Lightspeed Retail (R-Series)
    LIGHTSPEED_CLIENT_ID: str = ""
    LIGHTSPEED_CLIENT_SECRET: str = ""
    LIGHTSPEED_REDIRECT_URI: str = "http://localhost:8000/integrations/lightspeed/callback"
    # Provider token encryption key (Fernet — 32-byte URL-safe base64).
    # Generate: python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # If empty, a key is derived from SECRET_KEY via SHA-256 (acceptable for dev/test).
    PROVIDER_TOKEN_KEY: str = ""
    # Square webhook signature key for HMAC-SHA256 verification.
    # Set to the Signature Key shown in the Square Developer Console for your webhook endpoint.
    SQUARE_WEBHOOK_SIGNATURE_KEY: str = ""

    class Config:
        env_file = ".env"


settings = Settings()
