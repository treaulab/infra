#!/usr/bin/env bash
# Deploy the public Azure VPS stack (Caddy + static website) via rsync + compose.
# Usage: tools/deploy-public.sh [env]   (env defaults to prod)
#
# Host/user/domain come from fleet/inventory/<env>.yml. Override with
# SSH_HOST, SSH_USER, SSH_PORT, SSH_KEY, DOMAIN, ACME_EMAIL, SITE_IP,
# CADDY_VERSION, DEPLOY_ROOT.
#
# Caddy serves the static site only. It does not proxy homelab services.
set -euo pipefail

ENV="${1:-prod}"
LOG_DIR="logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/deploy-public-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
echo "== deploy-public $ENV started $(date -u +%FT%TZ), log: $LOG"

run() { printf '\n+ %s\n' "$*"; "$@"; }

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

INV="fleet/inventory/${ENV}.yml"
[[ -f "$INV" ]] || { echo "ERROR: $INV missing (copy from ${INV}.example)" >&2; exit 1; }

# The inventory is intentionally small YAML. Read one scalar key without
# pulling in a YAML dependency.
inv() {
  awk -v k="$1" '
    $1 == k":" {
      sub(/^[[:space:]]*[^:]+:[[:space:]]*/, "", $0)
      sub(/[[:space:]]*#.*/, "", $0)
      gsub(/^["'\'' ]|["'\'' ]$/, "", $0)
      print
      exit
    }
  ' "$INV"
}

# Read a key from inside a specific host block (the inventory has both edge
# and homelab hosts; the first ansible_host is not necessarily the target).
inv_host() {
  awk -v host="$1" -v key="$2" '
    {
      line=$0
      indent=match($0, /[^ ]/) - 1
      sub(/^[[:space:]]*/, "", line)
      if (line ~ "^" host ":[[:space:]]*$") { inhost=1; host_indent=indent; next }
      if (inhost) {
        if (indent <= host_indent && line ~ "^[^:]+:[[:space:]]*$") inhost=0
        if (index(line, key ":") == 1) {
          sub("^[^:]+:[[:space:]]*", "", line)
          sub(/[[:space:]]*#.*/, "", line)
          gsub(/^["'\'' ]|["'\'' ]$/, "", line)
          print line
          exit
        }
      }
    }
  ' "$INV"
}

HOST="${SSH_HOST:-$(inv_host vps ansible_host)}"
USER="${SSH_USER:-$(inv_host vps ansible_user)}"
ROOT="${DEPLOY_ROOT:-$(inv deploy_root)}"
ROOT="${ROOT:-/opt/treaulab}"
DOMAIN="${DOMAIN:-$(inv domain)}"
ACME_EMAIL="${ACME_EMAIL:-$(inv acme_email)}"
CADDY_VERSION="${CADDY_VERSION:-$(inv caddy_version)}"
CADDY_VERSION="${CADDY_VERSION:-2.11}"
SITE_IP="${SITE_IP:-$(inv site_ip)}"
SITE_IP="${SITE_IP:-$HOST}"
KEY="${SSH_KEY:-$(inv_host vps ansible_ssh_private_key_file)}"
KEY="${KEY/#\~/$HOME}"

[[ -n "$HOST" ]] || { echo "ERROR: ansible_host/SSH_HOST is empty" >&2; exit 1; }
[[ -n "$USER" ]] || { echo "ERROR: ansible_user/SSH_USER is empty" >&2; exit 1; }
: "${DOMAIN:?domain missing in $INV (or export DOMAIN=...)}"
: "${ACME_EMAIL:?acme_email missing in $INV (or export ACME_EMAIL=...)}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[[ -n "${KEY:-}" ]] && SSH_OPTS+=(-i "$KEY")
[[ -n "${SSH_PORT:-}" ]] && SSH_OPTS+=(-p "$SSH_PORT")
SSH=(ssh "${SSH_OPTS[@]}")
RSYNC=(rsync -az --delete -e "ssh ${SSH_OPTS[*]}")

# Render the non-secret Caddy env next to the stack; rsync ships it.
ENV_FILE="stacks/public/caddy/.env"
cat > "$ENV_FILE" <<ENVEOF
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
CADDY_VERSION=$CADDY_VERSION
SITE_IP=$SITE_IP
ENVEOF
chmod 600 "$ENV_FILE"
echo "Rendered $ENV_FILE (DOMAIN=$DOMAIN, SITE_IP=$SITE_IP)"

echo "Preflight: ssh $USER@$HOST ..."
run "${SSH[@]}" "$USER@$HOST" 'echo OK && docker --version'

echo "Validating Caddyfile locally ..."
run docker run --rm --network none --entrypoint caddy \
  -e "DOMAIN=$DOMAIN" -e "ACME_EMAIL=$ACME_EMAIL" -e "SITE_IP=$SITE_IP" \
  -v "$PWD/stacks/public/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "docker.io/library/caddy:$CADDY_VERSION" validate --config /etc/caddy/Caddyfile

echo "Validating compose config locally ..."
(cd stacks/public/caddy && compose config >/dev/null)

remote_hash() {
  "${SSH[@]}" "$USER@$HOST" \
    "sha256sum '$ROOT/stacks/public/caddy/Caddyfile' '$ROOT/stacks/public/caddy/compose.yml' '$ROOT/stacks/public/caddy/.env' 2>/dev/null | sha256sum | cut -d' ' -f1" 2>/dev/null || true
}
OLD_HASH="$(remote_hash)"

echo "Deploying to $USER@$HOST ($ENV) ..."
run "${SSH[@]}" "$USER@$HOST" "sudo mkdir -p '$ROOT/stacks/public/caddy' '$ROOT/stacks/public/website/src' && sudo chown -R \$USER:\$USER '$ROOT'"
run "${RSYNC[@]}" stacks/public/ "$USER@$HOST:$ROOT/stacks/public/"

NEW_HASH="$(remote_hash)"
if [[ "$OLD_HASH" != "$NEW_HASH" ]]; then
  echo "Caddy config changed — recreating the container."
  run "${SSH[@]}" "$USER@$HOST" "cd '$ROOT/stacks/public/caddy' && docker compose up -d --remove-orphans --pull always --force-recreate && docker ps"
else
  echo "Website files changed only — no container restart."
  run "${SSH[@]}" "$USER@$HOST" "cd '$ROOT/stacks/public/caddy' && docker compose up -d --remove-orphans --pull always && docker ps"
fi

echo "Verify: curl -sI https://$DOMAIN/ (should be 200); ssh $USER@$HOST 'docker logs caddy --tail 20'"
echo "== deploy-public done, full log: $LOG"
