#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

repo=/mnt/c/Users/AlexS/Projects/Vendora
runtime_dir=/etc/vendora
env_file=${runtime_dir}/compose.env
unit_file=/etc/systemd/system/vendora-compose.service

install -d -m 0700 -o root -g root "${runtime_dir}"

if [[ ! -f ${env_file} ]]; then
  secret_key=$(openssl rand -hex 48)
  postgres_password=$(openssl rand -hex 32)
  provider_token_key=$(openssl rand -base64 32 | tr '+/' '-_')

  umask 077
  {
    printf 'POSTGRES_USER=vendora\n'
    printf 'POSTGRES_PASSWORD=%s\n' "${postgres_password}"
    printf 'POSTGRES_DB=vendora\n'
    printf 'VENDORA_ENV_FILE=%s\n' "${env_file}"
    printf 'SECRET_KEY=%s\n' "${secret_key}"
    printf 'PROVIDER_TOKEN_KEY=%s\n' "${provider_token_key}"
    printf 'PUBLIC_API_BASE_URL=https://vendora.lexmakesit.com/api/v1\n'
    printf 'ALLOWED_ORIGIN=https://vendora.lexmakesit.com\n'
    printf 'TESTER_EMAIL_ALLOWLIST=management.donxera@gmail.com\n'
    printf 'EMAIL_FROM_EMAIL=noreply@lexmakesit.com\n'
    printf 'EMAIL_FROM_NAME=Vendora\n'
    printf 'SMTP_HOST=\n'
    printf 'SMTP_PORT=465\n'
    printf 'SMTP_USERNAME=\n'
    printf 'SMTP_PASSWORD=\n'
    printf 'SMTP_USE_TLS=false\n'
    printf 'SUPPORT_EMAIL=support@lexmakesit.com\n'
    printf 'PASSWORD_RESET_URL=https://vendora.lexmakesit.com/reset-password\n'
  } > "${env_file}"
  chmod 0600 "${env_file}"
fi

install -m 0644 -o root -g root \
  "${repo}/infra/self-hosted/vendora-compose.service" "${unit_file}"

systemctl daemon-reload
systemctl enable vendora-compose.service
