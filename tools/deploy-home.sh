#!/usr/bin/env bash
# Compatibility wrapper for the Ansible deploy path.
# Prefer: just deploy-home <app> [env]
#
# Looks for stacks/homelab/apps/<app>/ first, then stacks/homelab/core/<app>/.
# The old environment overrides are still accepted for one transition cycle:
# HOMELAB_HOST, SSH_USER, SSH_PORT, SSH_KEY, HOMELAB_ROOT.
set -euo pipefail

APP="${1:-}"
ENV="${2:-prod}"
[[ -n "$APP" ]] || { echo "usage: deploy-home.sh <app> [env]" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/deploy-home-${APP}-$(date +%Y%m%d-%H%M%S).log"

cd "$REPO_ROOT"
INV="fleet/inventory/${ENV}.yml"
[[ -f "$INV" ]] || { echo "ERROR: $INV missing (copy from ${INV}.example)" >&2; exit 1; }
command -v ansible-playbook >/dev/null || {
  echo "ERROR: ansible-playbook not installed; run just setup" >&2
  exit 1
}

EXTRA=(-e "stack_name=${APP}")
[[ -n "${HOMELAB_HOST:-}" ]] && EXTRA+=(-e "ansible_host=${HOMELAB_HOST}")
[[ -n "${SSH_USER:-}" ]] && EXTRA+=(-e "ansible_user=${SSH_USER}")
[[ -n "${SSH_PORT:-}" ]] && EXTRA+=(-e "ansible_port=${SSH_PORT}")
if [[ -n "${SSH_KEY:-}" ]]; then
  SSH_KEY="${SSH_KEY/#\~/$HOME}"
  EXTRA+=(-e "ansible_ssh_private_key_file=${SSH_KEY}")
fi
[[ -n "${HOMELAB_ROOT:-}" ]] && EXTRA+=(-e "homelab_root=${HOMELAB_ROOT}")
# Preserve the old wrapper's first-connect behaviour. The main Just path
# relies on known_hosts instead.
EXTRA+=(-e "ansible_ssh_common_args=-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15")

{
  printf '== deploy-home %s (Ansible; wrapper is deprecated) log: %s\n' "$APP" "$LOG"
  (cd fleet && ansible-playbook -i "inventory/${ENV}.yml" playbooks/deploy-home.yml \
    --limit homelab-vm "${EXTRA[@]}")
} 2>&1 | tee "$LOG"
