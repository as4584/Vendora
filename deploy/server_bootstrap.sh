#!/usr/bin/env bash
# Bootstraps a fresh Ubuntu 24.04 droplet for Vendora.
# Usage (run on the droplet as root):
#   curl -fsSL https://raw.githubusercontent.com/as4584/Vendora/sprint-5-lightspeed-deploy/deploy/server_bootstrap.sh | bash
set -euo pipefail

DOMAIN=${DOMAIN:-vendora.lexmakesit.com}
APP_DIR=${APP_DIR:-/opt/vendora}
REPO_URL=${REPO_URL:-https://github.com/as4584/Vendora.git}
BRANCH=${BRANCH:-sprint-5-lightspeed-deploy}
DEPLOY_USER=${DEPLOY_USER:-vendora}
DEPLOY_GROUP=${DEPLOY_GROUP:-vendora}

log() {
  echo "[bootstrap] $1"
}

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root" >&2
    exit 1
  fi
}

install_packages() {
  log "Updating apt cache"
  apt-get update -y
  apt-get upgrade -y

  log "Installing base packages"
  apt-get install -y ca-certificates curl gnupg lsb-release git ufw
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker already installed"
    return
  fi
  log "Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
$(. /etc/os-release && echo $VERSION_CODENAME) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    log "Caddy already installed"
    return
  fi
  log "Installing Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --batch --yes --dearmor -o /etc/apt/trusted.gpg.d/caddy-stable.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/deb/debian/caddy-stable.list \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
}

create_deploy_user() {
  if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
    log "User $DEPLOY_USER already exists"
  else
    log "Creating deploy user $DEPLOY_USER"
    adduser --disabled-password --gecos "" "$DEPLOY_USER"
  fi

  usermod -aG sudo "$DEPLOY_USER"
  usermod -aG docker "$DEPLOY_USER"

  mkdir -p "/home/$DEPLOY_USER/.ssh"
  if [[ -f /root/.ssh/authorized_keys ]]; then
    cp /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
  fi
  chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "/home/$DEPLOY_USER/.ssh"
  chmod 700 "/home/$DEPLOY_USER/.ssh"
  chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
}

clone_repo() {
  if [[ -d "$APP_DIR/.git" ]]; then
    log "Repository exists. Pulling latest changes"
    git -C "$APP_DIR" fetch --all
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  else
    log "Cloning repository"
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
}

ensure_env_file() {
  if [[ ! -f "$APP_DIR/.env.prod" ]]; then
    log "Creating .env.prod from template (edit values manually)"
    cp "$APP_DIR/deploy/.env.prod.example" "$APP_DIR/.env.prod"
  fi
}

configure_caddy() {
  log "Writing Caddyfile for $DOMAIN"
  cat <<EOF >/etc/caddy/Caddyfile
$DOMAIN {
    encode gzip zstd
    reverse_proxy 127.0.0.1:8000
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }
    log {
        output file /var/log/caddy/vendora-access.log
    }
}
EOF
  mkdir -p /var/log/caddy
  systemctl enable caddy
  systemctl restart caddy
}

start_stack() {
  log "Starting Docker stack"
  chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$APP_DIR"
  su - "$DEPLOY_USER" -c "cd $APP_DIR && docker compose -f docker-compose.prod.yml up -d --build"
}

configure_firewall() {
  if ufw status | grep -q inactive; then
    log "Configuring UFW"
    ufw allow OpenSSH
    ufw allow http
    ufw allow https
    ufw --force enable
  fi
}

configure_ssh() {
  log "Hardening SSH configuration"
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
  grep -q '^PubkeyAuthentication' /etc/ssh/sshd_config \
    && sed -i 's/^PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    || echo 'PubkeyAuthentication yes' >> /etc/ssh/sshd_config
  systemctl restart sshd
}

main() {
  require_root
  install_packages
  install_docker
  create_deploy_user
  install_caddy
  configure_firewall
  clone_repo
  ensure_env_file
  start_stack
  configure_caddy
  configure_ssh
  log "Bootstrap complete. Update $APP_DIR/.env.prod and redeploy if needed."
}

main "$@"
