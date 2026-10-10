# Vendora email delivery

## Production pipeline

Vendora is self-hosted, but transactional email is sent through Resend's
verified `lexmakesit.com` domain. This is the production path for password
resets and support notifications.

- Sender: `noreply@lexmakesit.com`
- Provider credential: `RESEND_API_KEY`, stored only in Doppler
  (`lexmakesit` / `prd`)
- Domain authentication: Resend DKIM/SPF records in Cloudflare; DMARC remains
  configured for `lexmakesit.com`

The backend uses SMTP only when `SMTP_HOST` is configured. Resend is the
production provider when SMTP is absent and `RESEND_API_KEY` is present.
GoDaddy SMTP keys may remain in Doppler as unused legacy credentials, but must
not be re-enabled without explicit approval.

## Doppler keys

```text
RESEND_API_KEY
EMAIL_FROM_EMAIL
EMAIL_FROM_NAME
```

Never commit, print, or paste `RESEND_API_KEY` or any other credential. Verify
only whether a key is present. The production runtime receives these values
through `/etc/vendora/compose.env`; restart `vendora-compose.service` after a
runtime secret change.

## DNS and deliverability

The sender identity does not require a paid mailbox. SPF, DKIM, and DMARC
records for `lexmakesit.com` must remain configured in DNS. DMARC is a policy
record; it does not send mail by itself.

## Future-agent checklist

When debugging password-reset email:

1. Check Doppler key presence only; do not expose values.
2. Check the container has `RESEND_API_KEY` after deployment and that
   `SMTP_HOST` is absent unless SMTP was explicitly selected.
3. Inspect backend logs for `Password reset email delivery failed`.
4. Run a disposable register → forgot-password → account-delete smoke test.
5. Do not create a new email provider or change DNS without explicit approval.

## Password-reset link

`PASSWORD_RESET_URL` is `https://vendora.lexmakesit.com/reset-password`. The
email links to that HTTPS bridge page with the token in the URL fragment
(`#token=...`), which browsers never send to the server. The page
(`backend/app/routers/reset_bridge.py`) is static, sends `no-store`,
`no-referrer` and a strict CSP, and opens the app at
`vendora://reset-password?token=...`. Never log reset tokens.

## Header and body safety

All outgoing mail goes through `_send_email()` in
`backend/app/services/email.py`, which sanitizes every header with
`backend/app/services/email_safety.py`:

- `safe_header()` for Subject and display names (no CR/LF or other control
  characters, collapsed whitespace, length cap);
- `validate_single_address()` for To and Reply-To (exactly one address);
- `escape_html()` for every piece of user text placed in an HTML body.

Do not build email headers or HTML bodies any other way.
