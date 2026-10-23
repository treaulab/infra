#!/usr/bin/env bash
# Deploy one private homelab stack over Tailscale via rsync + compose.
# Usage: tools/deploy-home.sh <app> [env]   (env defaults to prod)
#
# Looks for stacks/homelab/apps/<app>/ first, then stacks/homelab/core/<app>/.
# Host comes from fleet/inventory/<env>.yml (host "homelab-vm"). Override with
# HOMELAB_HOST, SSH_USER, SSH_PORT, SSH_KEY, HOMELAB_ROOT.
#
# Keep app data in named volumes or a path outside the synced directory:
# this script uses rsync --delete.
set -euo pipefail

APP="${1:-}"
ENV="${2:-prod}"
[[ -n "$APP" ]] || { echo "usage: deploy-home.sh <app> [env]" >&2; exit 1; }

if [[ -d "stacks/homelab/apps/$APP" ]]; then
  KIND=apps
  SRC="stacks/homelab/apps/$APP"
elif [[ -d "stacks/homelab/core/$APP" ]]; then
  KIND=core
  SRC="stacks/homelab/core/$APP"
else
  echo "ERROR: no stack at stacks/homelab/{apps,core}/$APP" >&2
  exit 1
fi

LOG_DIR="logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/deploy-home-$APP-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
echo "== deploy-home $APP ($KIND) started $(date -u +%FT%TZ), log: $LOG"

run() { printf '\n+ %s\n' "$*"; "$@"; }

INV="fleet/inventory/${ENV}.yml"
[[ -f "$INV" ]] || { echo "ERROR: $INV missing (copy from ${INV}.example)" >&2; exit 1; }

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

HOST="${HOMELAB_HOST:-$(inv_host homelab-vm ansible_host)}"
USER="${SSH_USER:-$(inv_host homelab-vm ansible_user)}"
ROOT="${HOMELAB_ROOT:-$(inv homelab_root)}"
ROOT="${ROOT:-/opt/homelab}"
KEY="${SSH_KEY:-$(inv_host homelab-vm ansible_ssh_private_key_file)}"
KEY="${KEY/#\~/$HOME}"

[[ -n "$HOST" ]] || { echo "ERROR: homelab ansible_host/HOMELAB_HOST is empty" >&2; exit 1; }
[[ -n "$USER" ]] || { echo "ERROR: ansible_user/SSH_USER is empty" >&2; exit 1; }

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[[ -n "${KEY:-}" ]] && SSH_OPTS+=(-i "$KEY")
[[ -n "${SSH_PORT:-}" ]] && SSH_OPTS+=(-p "$SSH_PORT")
SSH=(ssh "${SSH_OPTS[@]}")
RSYNC=(rsync -az --delete -e "ssh ${SSH_OPTS[*]}")

echo "Preflight: ssh $USER@$HOST ..."
run "${SSH[@]}" "$USER@$HOST" 'echo OK && docker --version'

run "${SSH[@]}" "$USER@$HOST" "sudo mkdir -p '$ROOT/$KIND/$APP' && sudo chown -R \$USER:\$USER '$ROOT/$KIND/$APP'"
run "${RSYNC[@]}" "$SRC/" "$USER@$HOST:$ROOT/$KIND/$APP/"
run "${SSH[@]}" "$USER@$HOST" "cd '$ROOT/$KIND/$APP' && docker compose up -d --remove-orphans --pull always && docker ps"

echo "== deploy-home $APP done, full log: $LOG"
