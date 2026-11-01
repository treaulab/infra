#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[zapret2-container] %s\n' "$*"; }

cleanup() {
  log "Shutdown signal received; cleaning up nftables and daemon..."
  if [[ -x /opt/zapret2/init.d/sysv/zapret2 ]]; then
    /opt/zapret2/init.d/sysv/zapret2 stop 2>/dev/null || true
  fi
  pkill -f nfqws2 2>/dev/null || true
  nft delete table inet zapret2 2>/dev/null || true
  log "Cleanup complete; exiting."
  exit 0
}

trap cleanup SIGTERM SIGINT

# Auto-detect WAN interface if IFACE_WAN is set to auto or empty
if [[ -f /opt/zapret2/config ]]; then
  if grep -qE '^IFACE_WAN=(auto|""|)?$' /opt/zapret2/config 2>/dev/null; then
    default_dev=$(ip -4 route show default 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')
    if [[ -n "$default_dev" ]]; then
      log "Auto-detected default WAN interface: $default_dev"
      sed -i "s/^IFACE_WAN=.*/IFACE_WAN=$default_dev/" /opt/zapret2/config
    fi
  fi
fi

log "Starting zapret2..."
/opt/zapret2/init.d/sysv/zapret2 start

# Populate nozapret set if refresh script exists
if [[ -x /opt/zapret2/ipset/refresh-exclude-live.sh ]]; then
  log "Refreshing exclusion set..."
  /opt/zapret2/ipset/refresh-exclude-live.sh 2>&1 || true
fi

log "zapret2 is running; waiting for signals..."
tail -f /dev/null &
wait $!
