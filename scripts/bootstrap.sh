#!/usr/bin/env bash
# Bootstrap local machine. On NixOS you need NO persistent installs:
#   - deploy path (deploy.sh): only ssh + rsync (already on most systems)
#   - ansible path (hardening): nix-shell -p ansible (ephemeral, nothing installed)
#   - tofu path (optional, VPS exists): nix-shell -p opentofu
set -euo pipefail
if ! command -v ssh >/dev/null || ! command -v rsync >/dev/null; then
  echo "Need ssh + rsync on PATH (NixOS: already in system packages)"
fi
# One-time: ansible collections used by playbooks (persists in ~/.ansible).
if command -v ansible-galaxy >/dev/null; then
  ansible-galaxy collection install community.general community.docker
else
  echo "For hardening only: nix-shell -p ansible --run 'ansible-galaxy collection install community.general community.docker'"
fi
echo "OK. Next: cp tofu/envs/prod.tfvars.example tofu/envs/prod.tfvars && cp ansible/inventory/prod.yml.example ansible/inventory/prod.yml"
