# Vendora — Data Security & Compliance Plan

## 🔐 Authentication

- Passwords hashed with bcrypt
- JWT-based session auth
- HTTPS only
- No plaintext passwords

## 💳 Stripe Security

- Webhook signature validation required
- Stripe secret keys stored in environment variables
- Never stored in database
- Test and production keys separated

## 📁 Data Handling

Sensitive data stored:

- Email
- Business name
- Stripe account ID

Not stored:

- Card numbers
- Bank credentials

Stripe handles PCI compliance.

## 🗑 Data Deletion Policy

User must be able to:

- Delete account
- Delete all associated inventory
- Delete invoices
- Delete transactions

Endpoint:
`DELETE /user/account`

## 🗄 Backups

- Daily automated DB backups
- 7-day retention minimum
- Restore testing quarterly

## 🧾 Logging

- Log errors
- Log failed webhooks
- Log failed payments
- Never log secrets
