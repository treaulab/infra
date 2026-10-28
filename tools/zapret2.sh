#!/usr/bin/env bash
#
# zapret2.sh — simple one-time installer for zapret2 DPI circumvention
#
# Builds nfqws2 from source (Debian/Ubuntu, arm64 or x86_64), installs
# /opt/zapret2, configures nftables (queue 300) with the proven FortiGate/RST
# bypass strategy (--lua-desync=oob:urp=midsld:char=a), sets up LAN
# exclusion, and registers the systemd unit + daily refresh cron.
#
# Usage:
#   sudo ./zapret2.sh [options]
#
# Options:
#   --lan CIDR       LAN network to exclude from NFQUEUE (auto-detected if omitted)
#   --source PATH    Path to zapret2 source directory or tar.gz archive
#   --repo URL       Git repository to clone (default: https://github.com/bol-van/zapret2.git)
#   --commit SHA     Git commit to checkout (default: 4a33055448ce5f4e7acc704e1fbe0d8a8a6aa08d)
#   --skip-apt       Do not run apt-get install for dependencies
#   --uninstall      Stop and disable zapret2, flush nft table, keep /opt/zapret2
#   --purge          With --uninstall, remove /opt/zapret2 and user tpws
#   -h, --help       Show this help
#

set -Eeuo pipefail
umask 022

INSTALL_DIR="/opt/zapret2"
SERVICE="zapret2"
REPO_URL="${REPO_URL:-https://github.com/bol-van/zapret2.git}"
GIT_COMMIT="${GIT_COMMIT:-4a33055448ce5f4e7acc704e1fbe0d8a8a6aa08d}"
LAN_CIDR=""
SOURCE_PATH=""
SKIP_APT=0
UNINSTALL=0
PURGE=0

log()  { printf '[zapret2] %s\n' "$*"; }
warn() { printf '[zapret2] WARNING: %s\n' "$*" >&2; }
die()  { printf '[zapret2] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sudo ./zapret2.sh [options]

Options:
  --lan CIDR       LAN network to exclude from NFQUEUE (auto-detected if omitted)
  --source PATH    Path to zapret2 source directory or tar.gz archive
  --repo URL       Git repository to clone (default: https://github.com/bol-van/zapret2.git)
  --commit SHA     Git commit to checkout (default: 4a33055448ce5f4e7acc704e1fbe0d8a8a6aa08d)
  --skip-apt       Skip apt-get package installation
  --uninstall      Stop/disable service, remove nftables table and cron job
  --purge          With --uninstall, also remove /opt/zapret2 and user tpws
  -h, --help       Show this help

Examples:
  sudo ./zapret2.sh
  sudo ./zapret2.sh --lan 192.168.10.0/24
  sudo ./zapret2.sh --uninstall
  sudo ./zapret2.sh --uninstall --purge
EOF
}

while (($#)); do
  case "$1" in
    --lan)
      [[ $# -ge 2 ]] || die "--lan requires a CIDR"
      LAN_CIDR="$2"
      shift 2
      ;;
    --source)
      [[ $# -ge 2 ]] || die "--source requires a path"
      SOURCE_PATH="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || die "--repo requires a URL"
      REPO_URL="$2"
      shift 2
      ;;
    --commit)
      [[ $# -ge 2 ]] || die "--commit requires a commit hash"
      GIT_COMMIT="$2"
      shift 2
      ;;
    --skip-apt)
      SKIP_APT=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --purge)
      PURGE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (use --help)"
      ;;
  esac
done

[[ $EUID -eq 0 ]] || die "must be run as root (e.g. sudo $0)"
if ((PURGE && ! UNINSTALL)); then
  die "--purge requires --uninstall"
fi

# ---- Uninstall -------------------------------------------------------------
if ((UNINSTALL)); then
  log "stopping and disabling $SERVICE"
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  if [[ -x "$INSTALL_DIR/init.d/sysv/zapret2" ]]; then
    "$INSTALL_DIR/init.d/sysv/zapret2" stop 2>/dev/null || true
  fi
  pkill -f "$INSTALL_DIR/.*nfqws2" 2>/dev/null || true
  nft delete table inet zapret2 2>/dev/null || true
  rm -f /etc/systemd/system/zapret2.service
  rm -f /etc/cron.d/zapret2-exclude
  systemctl daemon-reload

  if ((PURGE)); then
    log "purging $INSTALL_DIR and system user tpws"
    rm -rf -- "$INSTALL_DIR"
    userdel tpws 2>/dev/null || true
    rm -f /var/log/zapret2-exclude-refresh.log
  else
    log "preserved $INSTALL_DIR (use --purge to delete)"
  fi
  log "uninstalled successfully"
  exit 0
fi

command -v systemctl >/dev/null || die "systemd is required"

# ---- Dependencies ----------------------------------------------------------
if ((SKIP_APT == 0)) && command -v apt-get >/dev/null; then
  log "installing build and runtime dependencies"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    build-essential make gcc pkg-config git \
    nftables iproute2 cron curl ca-certificates \
    zlib1g-dev libcap-dev \
    libnetfilter-queue-dev libnfnetlink-dev libmnl-dev \
    libsystemd-dev libluajit-5.1-dev
fi

for cmd in make gcc pkg-config nft; do
  command -v "$cmd" >/dev/null || die "missing required tool: $cmd"
done

if command -v cron >/dev/null; then
  systemctl enable --now cron >/dev/null 2>&1 || true
else
  warn "cron daemon not found; daily exclusion refresh will not run automatically"
fi

# ---- LAN CIDR detection ----------------------------------------------------
if [[ -z "$LAN_CIDR" && -s "$INSTALL_DIR/ipset/zapret-hosts-user-exclude.txt" ]]; then
  LAN_CIDR=$(head -n 1 "$INSTALL_DIR/ipset/zapret-hosts-user-exclude.txt" | tr -d '[:space:]')
fi

if [[ -z "$LAN_CIDR" ]] && command -v ip >/dev/null; then
  dev=$(ip -4 route show default 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')
  if [[ -n "$dev" ]]; then
    LAN_CIDR=$(ip -4 route show dev "$dev" scope link 2>/dev/null | awk '/proto kernel/ {print $1; exit}')
  fi
fi

if [[ -z "$LAN_CIDR" ]]; then
  die "could not detect LAN CIDR; pass explicitly with --lan <CIDR> (e.g. --lan 192.168.10.0/24)"
fi

if [[ ! "$LAN_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
  die "invalid IPv4 CIDR: $LAN_CIDR"
fi
log "LAN exclusion target: $LAN_CIDR"

# ---- System user -----------------------------------------------------------
if ! getent passwd tpws >/dev/null; then
  log "creating system user tpws"
  useradd --system --no-create-home --shell /usr/sbin/nologin tpws
fi

# ---- Clean up legacy Byedpi / old Zapret -----------------------------------
log "cleaning up any conflicting services and rules"
systemctl disable --now zapret2 2>/dev/null || true
nft delete table inet zapret2 2>/dev/null || true

# If byedpi was previously active on the host, disable it and remove old redirects
systemctl disable --now byedpi-nat byedpi-transparent byedpi-socks 2>/dev/null || true
for _ in $(seq 1 5); do
  iptables -t nat -D OUTPUT -p tcp --dport 80 -j REDIRECT --to-ports 1081 2>/dev/null || break
done
for _ in $(seq 1 5); do
  iptables -t nat -D OUTPUT -p tcp --dport 443 -j REDIRECT --to-ports 1081 2>/dev/null || break
done
if [[ -f /etc/privoxy/config ]] && grep -q '^forward-socks5 / 127.0.0.1:1080' /etc/privoxy/config; then
  sed -i 's|^forward-socks5 / 127.0.0.1:1080 \.|# disabled-by-zapret2: forward-socks5 / 127.0.0.1:1080 .|' /etc/privoxy/config
  systemctl restart privoxy 2>/dev/null || true
fi

# ---- Backup existing /opt/zapret2 -----------------------------------------
BACKUP=""
if [[ -d "$INSTALL_DIR" ]]; then
  BACKUP="${INSTALL_DIR}.bak.$(date +%Y%m%d-%H%M%S)-$$"
  log "backing up existing $INSTALL_DIR -> $BACKUP"
  mv -- "$INSTALL_DIR" "$BACKUP"
fi

trap 'rc=$?; trap - ERR; echo "[zapret2] ERROR at line $LINENO (exit $rc)" >&2; if [[ -n ${BACKUP:-} && -d ${BACKUP:-} ]]; then echo "[zapret2] rollback: rm -rf $INSTALL_DIR && mv $BACKUP $INSTALL_DIR && systemctl enable --now $SERVICE" >&2; fi; exit $rc' ERR

# ---- Resolve zapret2 source ------------------------------------------------
mkdir -p "$INSTALL_DIR"

# 1. Check explicit --source
if [[ -n "$SOURCE_PATH" ]]; then
  if [[ -f "$SOURCE_PATH" ]]; then
    log "extracting source archive: $SOURCE_PATH"
    tar -C "$INSTALL_DIR" --strip-components=1 -xzf "$SOURCE_PATH"
  elif [[ -d "$SOURCE_PATH" ]]; then
    log "copying source directory: $SOURCE_PATH"
    cp -a "$SOURCE_PATH/." "$INSTALL_DIR/"
  else
    die "source path not found: $SOURCE_PATH"
  fi
# 2. Check local replica archives in home / bundle folders
elif [[ -f "./payload/source-zapret2-working-tree.tar.gz" ]]; then
  log "using local payload archive: ./payload/source-zapret2-working-tree.tar.gz"
  tar -C "$INSTALL_DIR" --strip-components=1 -xzf "./payload/source-zapret2-working-tree.tar.gz"
elif [[ -f "/home/trueking/Safe/zapret2-replica/payload/source-zapret2-working-tree.tar.gz" ]]; then
  log "using local replica archive from Safe"
  tar -C "$INSTALL_DIR" --strip-components=1 -xzf "/home/trueking/Safe/zapret2-replica/payload/source-zapret2-working-tree.tar.gz"
# 3. Clone upstream git
else
  command -v git >/dev/null || die "git is required to clone zapret2 (or specify --source)"
  log "cloning zapret2 from $REPO_URL"
  git clone "$REPO_URL" "$INSTALL_DIR"
  if [[ -n "$GIT_COMMIT" ]]; then
    log "checking out commit $GIT_COMMIT"
    (cd "$INSTALL_DIR" && git checkout -q "$GIT_COMMIT")
  fi
fi

# Remove git metadata and any stale historical hooks
rm -rf "$INSTALL_DIR/.git"
rm -f "$INSTALL_DIR/init.d/sysv/custom.d/10-cloudflared-bypass"

# ---- Build nfqws2 ---------------------------------------------------------
log "building nfqws2 for $(uname -m) (make systemd)"
if make -C "$INSTALL_DIR" systemd; then
  log "build target 'systemd' succeeded"
else
  warn "build target 'systemd' failed; trying default 'make'"
  make -C "$INSTALL_DIR"
fi

[[ -x "$INSTALL_DIR/binaries/my/nfqws2" ]] || die "nfqws2 executable not found after build"

# ---- Configure /opt/zapret2/config ----------------------------------------
log "generating zapret2 configuration"
if [[ ! -f "$INSTALL_DIR/config" && -f "$INSTALL_DIR/config.default" ]]; then
  cp "$INSTALL_DIR/config.default" "$INSTALL_DIR/config"
fi

# Strip out old override section if present to stay idempotent
if grep -q '# ---- byedpi-equivalent OOB setup ----' "$INSTALL_DIR/config" 2>/dev/null; then
  sed -i '/# ---- byedpi-equivalent OOB setup ----/,$d' "$INSTALL_DIR/config"
fi

cat >> "$INSTALL_DIR/config" <<'CFG'

# ---- byedpi-equivalent OOB setup ----
FWTYPE=nftables
MODE_FILTER=none
DISABLE_IPV6=1
NFQWS2_ENABLE=1
NFQWS2_PORTS_TCP=443
NFQWS2_PORTS_UDP=
NFQWS2_TCP_PKT_OUT=20
NFQWS2_TCP_PKT_IN=10
NFQWS2_UDP_PKT_OUT=0
NFQWS2_UDP_PKT_IN=0
NFQWS2_OPT="--filter-tcp=443 --in-range=-s1 --lua-desync=oob:urp=midsld:char=a"
WS_USER=tpws
QNUM=300
DESYNC_MARK=0x40000000
FLOWOFFLOAD=donttouch
CFG

# ---- Exclusions ------------------------------------------------------------
mkdir -p "$INSTALL_DIR/ipset"
printf '%s\n' "$LAN_CIDR" > "$INSTALL_DIR/ipset/zapret-hosts-user-exclude.txt"
printf '%s\n' "$LAN_CIDR" > "$INSTALL_DIR/ipset/zapret-ip-exclude.txt"
chmod 0644 "$INSTALL_DIR/ipset/zapret-hosts-user-exclude.txt" \
           "$INSTALL_DIR/ipset/zapret-ip-exclude.txt"

# ---- Exclusion refresh script ----------------------------------------------
cat > "$INSTALL_DIR/ipset/refresh-exclude-live.sh" <<'EOF'
#!/bin/sh
# refresh-exclude-live.sh
# Refresh the zapret2 "nozapret" exclusion set from the managed domain list
# ipset/zapret-hosts-user-exclude.txt, without reloading firewall rules or
# restarting zapret2. Safe to run while zapret2 is live (root required).
cd "$(dirname "$0")" || exit 1
. ./def.sh || exit 1
. "$ZAPRET_BASE/common/fwtype.sh" || exit 1
. "$ZAPRET_BASE/common/nft.sh" || exit 1

getexclude || exit 1
[ -f "$ZIPLIST_EXCLUDE" ] || { echo "missing $ZIPLIST_EXCLUDE"; exit 1; }

echo "$(date +%F\ %T) refreshing set $ZIPSET_EXCLUDE from $ZIPLIST_EXCLUDE ($(wc -l < "$ZIPLIST_EXCLUDE") IPs)"
nft flush set inet "$ZAPRET_NFT_TABLE" "$ZIPSET_EXCLUDE" || exit 1
while read -r ip; do
  [ -n "$ip" ] || continue
  nft add element inet "$ZAPRET_NFT_TABLE" "$ZIPSET_EXCLUDE" "{ $ip }" || true
done < "$ZIPLIST_EXCLUDE"
echo "$(date +%F\ %T) done"
nft list set inet "$ZAPRET_NFT_TABLE" "$ZIPSET_EXCLUDE" | sed -n '/elements/,$p'
EOF
chmod 0755 "$INSTALL_DIR/ipset/refresh-exclude-live.sh"

# ---- Daily Cron ------------------------------------------------------------
cat > /etc/cron.d/zapret2-exclude <<'EOF'
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# daily refresh of zapret2 nozapret set (LAN CIDR only)
17 4 * * * root /opt/zapret2/ipset/refresh-exclude-live.sh >>/var/log/zapret2-exclude-refresh.log 2>&1
EOF
chmod 0644 /etc/cron.d/zapret2-exclude

# ---- systemd Service Unit --------------------------------------------------
cat > /etc/systemd/system/zapret2.service <<'EOF'
[Unit]
Description=zapret2 DPI bypass service
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
Restart=no
TimeoutSec=30sec
IgnoreSIGPIPE=no
GuessMainPID=no
RemainAfterExit=no
ExecStart=/opt/zapret2/init.d/sysv/zapret2 start
ExecStop=/opt/zapret2/init.d/sysv/zapret2 stop

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 /etc/systemd/system/zapret2.service

# ---- Start and Verify ------------------------------------------------------
log "enabling and starting $SERVICE"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

for _ in $(seq 1 15); do
  systemctl is-active --quiet "$SERVICE" && break
  sleep 1
done

if ! systemctl is-active --quiet "$SERVICE"; then
  systemctl status "$SERVICE" --no-pager -l || true
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  die "service $SERVICE failed to start"
fi

# Refresh live exclusion set
log "refreshing nozapret exclusion set"
"$INSTALL_DIR/ipset/refresh-exclude-live.sh" >/dev/null 2>&1 || true

# Verify nftables queue 300 rule
queue_ready=0
for _ in $(seq 1 30); do
  nft_table=$(nft list table inet zapret2 2>/dev/null || true)
  if [[ "$nft_table" == *'queue flags bypass to 300'* ]]; then
    queue_ready=1
    break
  fi
  sleep 1
done

if ((queue_ready == 0)); then
  die "queue 300 rule not found in nft table inet zapret2 after 30s"
fi

log "zapret2 successfully installed and running!"
printf '\n'
systemctl --no-pager -l status "$SERVICE" | sed -n '1,12p' || true
printf '\n'
printf 'Running daemon:\n'
pgrep -a -x nfqws2 || true
printf '\n'
printf 'Verification commands:\n'
printf '  systemctl is-active zapret2\n'
printf '  sudo journalctl -u zapret2 -b --no-pager\n'
printf '  sudo nft list table inet zapret2\n'
printf '  sudo nft list set inet zapret2 nozapret\n'
printf '  curl -4 -sS -o /dev/null -m 10 -w "%%{http_code}\\n" https://github.com/\n'
printf '\nUninstall command:\n'
printf '  sudo %s --uninstall\n' "$0"
if [[ -n "$BACKUP" ]]; then
  printf 'Previous install backup: %s\n' "$BACKUP"
fi
