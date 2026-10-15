#!/usr/bin/env bash
# Deploy the Caddy + static website stack to the VPS via rsync + docker compose.
# Usage:
#   SSH_KEY=~/.ssh/id_ed25519 ./scripts/deploy.sh prod
#
# Host, user and site vars come from ansible/inventory/<env>.yml. Override any
# with env vars: SSH_HOST, SSH_USER, SSH_PORT, DOMAIN, ACME_EMAIL, CADDY_VERSION.
#
# Logging: everything printed here streams to your terminal AND is appended
# to logs/deploy-<timestamp>.log. Each ssh/rsync invocation is echoed first
# with a '+' prefix, so you can always see exactly what ran where.
set -euo pipefail
ENV="${1:-prod}"
LOG_DIR="logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
echo "== deploy $ENV started $(date -u +%FT%TZ), log: $LOG"

# run: echo the full command, then execute it.
run() { printf '\n+ %s\n' "$*"; "$@"; }

INV="ansible/inventory/${ENV}.yml"
[[ -f "$INV" ]] || { echo "ERROR: $INV missing (from ${ENV}.yml.example)"; exit 1; }

# Inventory is a 3-key YAML file; pull values without needing a YAML parser.
inv() { grep -E "^\s+$1:" "$INV" | head -1 | sed -E "s/^\s+$1:\s*//; s/\s*#.*//; s/^['\"]//; s/['\"]\s*$//"; }

HOST="${SSH_HOST:-$(inv ansible_host)}"
USER="${SSH_USER:-$(inv ansible_user)}"
ROOT="${DEPLOY_ROOT:-/opt/treaulab}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
[[ -n "${SSH_KEY:-}" ]] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
[[ -n "${SSH_PORT:-}" ]] && SSH_OPTS="$SSH_OPTS -p $SSH_PORT"
# shellcheck disable=SC2086
SSH="ssh $SSH_OPTS"
RSYNC="rsync -avz -e \"$SSH\""

echo "Preflight: ssh $USER@$HOST ..."
# shellcheck disable=SC2086
run $SSH "$USER@$HOST" 'echo OK && docker --version'

# Render apps/caddy/.env from the inventory (gitignored, regenerated each run).
# Caddyfile/compose also carry defaults, so this is belt-and-braces.
DOMAIN="${DOMAIN:-$(inv domain)}"
ACME_EMAIL="${ACME_EMAIL:-$(inv acme_email)}"
CADDY_VERSION="${CADDY_VERSION:-$(inv caddy_version)}"
SITE_IP="$HOST"
: "${DOMAIN:?domain missing in $INV (or export DOMAIN=...)}"
: "${ACME_EMAIL:?acme_email missing in $INV (or export ACME_EMAIL=...)}"
CADDY_VERSION="${CADDY_VERSION:-2.11}"
cat > apps/caddy/.env <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
CADDY_VERSION=$CADDY_VERSION
SITE_IP=$SITE_IP
EOF
echo "Rendered apps/caddy/.env (DOMAIN=$DOMAIN, SITE_IP=$SITE_IP)"

echo "Deploying to $USER@$HOST ($ENV) ..."
# Server mirrors repo layout under $ROOT: apps/caddy, apps/website/src
# (compose volume paths are repo-relative, so the tree must match).
# shellcheck disable=SC2086,SC2029
run $SSH "$USER@$HOST" "sudo mkdir -p $ROOT/apps/caddy $ROOT/apps/website/src && sudo chown -R \$USER:\$USER $ROOT"
# shellcheck disable=SC2086
eval "run $RSYNC --delete apps/caddy/ \"$USER@$HOST:$ROOT/apps/caddy/\""
# shellcheck disable=SC2086
eval "run $RSYNC --delete apps/website/src/ \"$USER@$HOST:$ROOT/apps/website/src/\""
# shellcheck disable=SC2086,SC2029
run $SSH "$USER@$HOST" "cd $ROOT/apps/caddy && docker compose up -d --pull always --force-recreate --remove-orphans && docker ps"
echo "Verify: curl -sI https://$DOMAIN/ (should be 200); ssh $USER@$HOST 'docker logs caddy --tail 20'"
echo "== deploy done, full log: $LOG"
