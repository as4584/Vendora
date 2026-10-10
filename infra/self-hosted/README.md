# Vendora laptop production service

`vendora-compose.service` starts the PostgreSQL and FastAPI containers after
WSL's Docker service and the LexMakesIt edge network are available.

- API loopback endpoint: `http://127.0.0.1:18083/api/v1/health`
- Cloudflare service target: `http://vendora-backend:8000`
- Runtime secrets: `/etc/vendora/compose.env` (root-readable only)
- Persistent database volume: `vendora-prod_vendora_db_data`

Operational commands:

```bash
systemctl status vendora-compose.service
journalctl -u vendora-compose.service
docker compose -p vendora-prod --env-file /etc/vendora/compose.env -f /mnt/c/Users/AlexS/Projects/Vendora/docker-compose.prod.yml ps
systemctl stop vendora-compose.service
```

## How this deployment fits together

- Production is self-hosted on the owner's Windows PC under WSL Ubuntu. The
  retired DigitalOcean droplet scripts in `deploy/` are not used.
- `docker-compose.prod.yml` requires `POSTGRES_USER`, `POSTGRES_PASSWORD` and
  `POSTGRES_DB` from `/etc/vendora/compose.env`; there are no default
  credentials. `install.sh` generates the secrets on first install, and they
  are never committed.
- Email: Resend is the primary provider (`RESEND_API_KEY` in the env file).
  SMTP settings are an optional fallback and are left empty in production.
  See [`docs/EMAIL_DELIVERY.md`](../../docs/EMAIL_DELIVERY.md).
- The Cloudflare Tunnel runs in the separate LexMakesIt edge stack (network
  `lexmakesit-prod_edge`). Its token lives in that stack's Docker secret, not
  in this repository.

## Deploying a committed SHA

The service builds from the working tree at `/mnt/c/Users/AlexS/Projects/Vendora`,
so uncommitted edits in that folder end up in production. To deploy, check out
the reviewed commit on `main` in that folder (`git status` must be clean), then
run `systemctl restart vendora-compose.service` and verify
`https://vendora.lexmakesit.com/api/v1/health`.
