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
    # Grandfather early free users into Pro market pricing for a while.
    # Users created before CUTOFF (the release date, ISO) keep it for
    # PRICING_GRACE_DAYS after it, or until PRICING_GRACE_UNTIL if set. Unset CUTOFF = off.
    PRICING_GRACE_CUTOFF: str = ""
    PRICING_GRACE_DAYS: int = 7
    PRICING_GRACE_UNTIL: str = ""
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
    EMAIL_FROM_NAME: str = "Resqlo"
    # Discord webhook — in-app support requests are mirrored to the team channel.
    DISCORD_WEBHOOK_URL: str = ""
    # HTTPS keeps reset links clickable in Gmail; the bridge page served by
    # app/routers/reset_bridge.py opens the app's vendora:// reset screen.
    PASSWORD_RESET_URL: str = "https://vendora.lexmakesit.com/reset-password"
    PASSWORD_RESET_TOKEN_EXPIRE_MINUTES: int = 30
    # Apple Developer Team ID. When set, /.well-known/apple-app-site-association
    # lets iOS open reset links straight in the app (Universal Links).
    APPLE_TEAM_ID: str = ""
    IOS_BUNDLE_ID: str = "com.vendora.app"
    # Hosted web app origin: OAuth popups started on web report back here.
    WEB_APP_URL: str = "https://vendora.lexmakesit.com"
    INTEGRATION_SUCCESS_URL: str = "vendora://settings?integration=lightspeed&status=connected"
    # Stripe
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PRO_PRICE_ID: str = ""  # Stripe Price ID for Pro tier ($20/mo)
    STRIPE_PARTNER_PRICE_ID: str = ""  # Stripe Price ID for Partner add-on ($5/mo)
    # RevenueCat (iOS in-app purchases). The webhook sends this exact value in
    # the Authorization header; set the same string in the RevenueCat dashboard.
    REVENUECAT_WEBHOOK_AUTH: str = ""
    # RevenueCat secret (sk_...) API key. Optional: when set, deleting a Resqlo
    # account also deletes the RevenueCat customer record (privacy erasure).
    REVENUECAT_SECRET_KEY: str = ""
    # Directory holding the Expo web export (mobile `expo export --platform web`).
    # When it exists, the backend serves the web app at "/" (SPA fallback).
    WEB_DIST_DIR: str = ""
    SUPPORT_EMAIL: str = "support@lexmakesit.com"
    # Lightspeed Retail (R-Series)
    LIGHTSPEED_CLIENT_ID: str = ""
    LIGHTSPEED_CLIENT_SECRET: str = ""
    LIGHTSPEED_REDIRECT_URI: str = "http://localhost:8000/integrations/lightspeed/callback"
    # eBay Sell/Buy APIs (import, listing write-back, comps). Switch sandbox/production via EBAY_ENV.
    EBAY_CLIENT_ID: str = ""        # App ID (Client ID) from the eBay developer portal
    EBAY_CLIENT_SECRET: str = ""    # Cert ID (Client Secret)
    EBAY_RUNAME: str = ""           # Redirect URL name (RuName) — used as redirect_uri in OAuth
    EBAY_ENV: str = "sandbox"       # "sandbox" | "production"
    # Marketplace Insights (sold-price data) is a restricted API eBay grants on
    # application. Leave False on a standard keyset: comps then use Browse
    # active listings, labelled as asking prices (never as sold prices).
    EBAY_MARKETPLACE_INSIGHTS: bool = False
    # Notification API destination (must be public HTTPS and match the URL
    # registered as the destination). Order topics to subscribe to; eBay's
    # topic catalog (getTopics) is the source of truth for the names.
    EBAY_NOTIFICATION_ENDPOINT: str = "https://vendora.lexmakesit.com/api/v1/integrations/ebay/notifications"
    EBAY_ORDER_TOPICS: str = "ITEM_SOLD"
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
    # Google Sheets sync (OAuth web client). Scopes: drive.file + openid email.
    # See docs/features/GOOGLE_SHEETS_SYNC.md for the Google Cloud setup.
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    GOOGLE_REDIRECT_URI: str = "https://vendora.lexmakesit.com/api/v1/integrations/google/callback"
    # Optional browser API key for the Google Picker on web ("Use an existing sheet").
    GOOGLE_PICKER_API_KEY: str = ""
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
