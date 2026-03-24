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
    # Stripe
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PRO_PRICE_ID: str = ""  # Stripe Price ID for Pro tier ($20/mo)
    # Lightspeed Retail (R-Series)
    LIGHTSPEED_CLIENT_ID: str = ""
    LIGHTSPEED_CLIENT_SECRET: str = ""
    LIGHTSPEED_REDIRECT_URI: str = "http://localhost:8000/integrations/lightspeed/callback"

    class Config:
        env_file = ".env"


settings = Settings()
