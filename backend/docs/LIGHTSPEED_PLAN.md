# Lightspeed Integration - Sprint 5

Goal: One-way sync (Lightspeed R-Series → Vendora)

## Requirements

- OAuth 2.0 connection
- Store tokens per user in lightspeed_tokens table
- Endpoints:
  - GET /integrations/lightspeed/connect
  - GET /integrations/lightspeed/callback
  - POST /integrations/lightspeed/sync
- Deduplicate using:
  (user_id, source="lightspeed", external_id)
- Rate limit: 60 req/min (add throttle wrapper)
- No two-way sync yet

Future: Replace POS (Phase 4)