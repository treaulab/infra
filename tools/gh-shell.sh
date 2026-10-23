#!/usr/bin/env bash
# gh-shell — one-command Tailscale SSH launcher for tailnet-runner spokes.
# Usage:
#   ./tools/gh-shell.sh [t1]              # dispatch + wait + ssh (default t1)
#   ./tools/gh-shell.sh t2 --no-dispatch  # ssh to latest live node only
#
# Requires on the laptop: gh (authed), tailscale (up), jq.
# Spoke repo must have run at least once; t2 has a 180s stagger so waiting
# up to 240s is normal.
set -euo pipefail
TENANT="${1:-t1}"
REPO="${SPOKE_REPO:-andrewwang2161/dotfiles}"
WORKFLOW="${SPOKE_WORKFLOW:-tailnet-runner.yml}"
WAIT_SECS="${WAIT_SECS:-240}"

if [[ "${2:-}" != "--no-dispatch" ]]; then
  echo "==> Dispatching $WORKFLOW (tenant=$TENANT) in $REPO ..."
  gh workflow run "$WORKFLOW" --repo "$REPO" -f "tenant=$TENANT"
  echo "==> Dispatch sent. Waiting for gh-${TENANT}-<run-id> on the tailnet ..."
else
  echo "==> Skipping dispatch (--no-dispatch). Looking for live gh-${TENANT}-* ..."
fi

for _ in $(command -v jq >/dev/null || echo MISSING); do
  if [[ "$_" == "MISSING" ]]; then echo "Need jq on PATH" >&2; exit 1; fi
done

NODE=""
for ((i=0; i<WAIT_SECS/5; i++)); do
  # Prefer exact run-id match when we just dispatched; fallback to newest prefix match.
  NODE="$(tailscale status --json 2>/dev/null | jq -r --arg p "gh-${TENANT}-" '[.Peer[] | select(.HostName | startswith($p)) | .HostName] | sort | last // empty')"
  if [[ -n "$NODE" ]]; then
    echo "==> Node found: $NODE"
    break
  fi
  sleep 5
done

if [[ -z "$NODE" ]]; then
  echo "Timed out after ${WAIT_SECS}s waiting for gh-${TENANT}-*. Is the workflow running? Check: gh run list --repo $REPO --workflow $WORKFLOW --limit 5" >&2
  exit 1
fi

echo "==> Connecting: tailscale ssh runner@$NODE (end debug early with: echo done > /tmp/tailnet-wake)"
exec tailscale ssh "runner@$NODE"
