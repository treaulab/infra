#!/usr/bin/env bash
# NAT-box installer + preflight for the stable cloudflared tunnel.
# Runs ONLY on the computer behind NAT. Never run on the Azure VPS.
# Usage: ./apps/cloudflared/install.sh [--check-only]
set -euo pipefail

CHECK_ONLY=0
[[ "${1:-}" == "--check-only" ]] && CHECK_ONLY=1

echo "== cloudflared preflight (NAT box only, VPS untouched)"

# 1. cloudflared present?
if command -v cloudflared >/dev/null 2>&1; then
  echo "+ cloudflared: $(cloudflared --version 2>&1 | head -1)"
else
  echo "!! cloudflared missing"
  if [[ $CHECK_ONLY -eq 1 ]]; then exit 1; fi
  echo "→ install (debian/ubuntu):"
  echo "  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null"
  echo "  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list"
  echo "  sudo apt-get update && sudo apt-get install -y cloudflared"
  echo "→ or binary: curl -fsSLO https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared-linux-amd64 && sudo mv cloudflared-linux-amd64 /usr/bin/cloudflared"
  exit 1
fi

# 2. upstreams listening? (warn only — your ports may differ)
for p in 8080 22; do
  if (command -v ss >/dev/null && ss -tln 2>/dev/null | grep -q ":$p ") || (command -v netstat >/dev/null && netstat -tln 2>/dev/null | grep -q ":$p "); then
    echo "+ localhost:$p listening"
  else
    echo "·· localhost:$p not detected (ok if your app/ssh uses another port — update config.yml)"
  fi
done

# 3. outbound 7844/443 to Cloudflare edge? (informational — fallback to 443 is fine)
echo "+ probing outbound to Cloudflare edge (7844/UDP QUIC, 443/TCP fallback)..."
if command -v nc >/dev/null 2>&1; then
  if nc -uvz -w5 region1.v2.argotunnel.com 7844 2>&1 | grep -qiE 'succeeded|open|connected'; then
    echo "+ 7844/UDP reachable (QUIC fast path OK)"
  else
    echo "·· 7844/UDP not confirmed — 443/TCP fallback will be used (still fine)"
  fi
  if nc -vz -w5 region1.v2.argotunnel.com 443 2>&1 | grep -qiE 'succeeded|open|connected'; then
    echo "+ 443/TCP reachable (fallback OK)"
  else
    echo "!! 443/TCP unreachable — egress blocked? Allow outbound 443 at minimum."
    exit 1
  fi
else
  echo "·· nc missing — skip probe (cloudflared run will show Registered tunnel connection on success)"
fi

# 4. config present?
if [[ -f /etc/cloudflared/config.yml ]]; then
  echo "+ /etc/cloudflared/config.yml present"
  if grep -q '<YOUR-TUNNEL-UUID>' /etc/cloudflared/config.yml 2>/dev/null; then
    echo "!! config.yml still has placeholder <YOUR-TUNNEL-UUID> — fill it (see README §2-3)"
    exit 1
  fi
  if grep -q 'http_status:404' /etc/cloudflared/config.yml 2>/dev/null; then
    echo "+ catch-all http_status:404 present"
  else
    echo "!! config.yml missing catch-all '- service: http_status:404' — cloudflared will refuse to run"
    exit 1
  fi
else
  echo "·· /etc/cloudflared/config.yml missing — copy from apps/cloudflared/config.yml.example (see README §3)"
fi

echo "== preflight done. Next: README §2 (tunnel create) → §4 (systemd run) → §5 (curl + ssh test)"
