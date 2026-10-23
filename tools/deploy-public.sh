#!/usr/bin/env bash
# Compatibility wrapper for the Ansible deploy path.
# Prefer: just deploy-public [env]
#
# Host/user/domain come from fleet/inventory/<env>.yml. The old environment
# overrides are still accepted for one transition cycle:
# SSH_HOST, SSH_USER, SSH_PORT, SSH_KEY, DOMAIN, ACME_EMAIL, SITE_IP,
# CADDY_VERSION, DEPLOY_ROOT.
set -euo pipefail

ENV="${1:-prod}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/deploy-public-${ENV}-$(date +%Y%m%d-%H%M%S).log"

cd "$REPO_ROOT"
INV="fleet/inventory/${ENV}.yml"
[[ -f "$INV" ]] || { echo "ERROR: $INV missing (copy from ${INV}.example)" >&2; exit 1; }
command -v ansible-playbook >/dev/null || {
  echo "ERROR: ansible-playbook not installed; run just setup" >&2
  exit 1
}

EXTRA=()
[[ -n "${SSH_HOST:-}" ]] && EXTRA+=(-e "ansible_host=${SSH_HOST}")
[[ -n "${SSH_USER:-}" ]] && EXTRA+=(-e "ansible_user=${SSH_USER}")
[[ -n "${SSH_PORT:-}" ]] && EXTRA+=(-e "ansible_port=${SSH_PORT}")
if [[ -n "${SSH_KEY:-}" ]]; then
  SSH_KEY="${SSH_KEY/#\~/$HOME}"
  EXTRA+=(-e "ansible_ssh_private_key_file=${SSH_KEY}")
fi
[[ -n "${DOMAIN:-}" ]] && EXTRA+=(-e "domain=${DOMAIN}")
[[ -n "${ACME_EMAIL:-}" ]] && EXTRA+=(-e "acme_email=${ACME_EMAIL}")
[[ -n "${SITE_IP:-}" ]] && EXTRA+=(-e "site_ip=${SITE_IP}")
[[ -n "${CADDY_VERSION:-}" ]] && EXTRA+=(-e "caddy_version=${CADDY_VERSION}")
[[ -n "${DEPLOY_ROOT:-}" ]] && EXTRA+=(-e "deploy_root=${DEPLOY_ROOT}")
# Preserve the old wrapper's first-connect behaviour. The main Just/CI path
# relies on known_hosts instead.
EXTRA+=(-e "ansible_ssh_common_args=-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15")

{
  printf '== deploy-public %s (Ansible; wrapper is deprecated) log: %s\n' "$ENV" "$LOG"
  (cd fleet && ansible-playbook -i "inventory/${ENV}.yml" playbooks/deploy-public.yml \
    --limit vps "${EXTRA[@]}")
} 2>&1 | tee "$LOG"
