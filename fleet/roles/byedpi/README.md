# `byedpi` Ansible Role

Deploys and manages **ByeDPI** (`ciadpi` v0.17.3) transparent and SOCKS5 proxies on untrusted workstation nodes (`beefyboi`, `scrawnyboi`, `nucboi`) behind Russian ISP TSPU DPI.

---

## Architecture Overview

Workstations route default WAN traffic directly via the physical USG gateway (`192.168.10.1`) rather than depending on the Proxmox router VM (`192.168.10.254`). To circumvent ISP SNI RST injection and TLS tampering on workstations, `ciadpi` runs locally as an unprivileged systemd service.

```mermaid
flowchart LR
    Apps["Local Apps / Docker / apt"] -->|TCP 80/443| NAT["iptables NAT OUTPUT\n(/usr/local/sbin/byedpi-nat.sh)"]
    NAT -->|LAN / Tailscale / 23.0.0.0/8| Direct["Direct WAN Gateway\n(192.168.10.1)"]
    NAT -->|External Web Traffic| Ciadpi["ciadpi (:1081)\n(--oob 1+s --auto=torst)"]
    Ciadpi --> Direct
    CLI["CLI / Browsers"] -->|SOCKS5 (:1080)| Ciadpi
```

### Components Deployed
1. **Binary**: `/usr/local/bin/ciadpi` (v0.17.3 fetched from unblocked GitLab mirror `https://gitlab.com/samuellance73/byedpi`).
2. **Transparent Proxy**: `byedpi-transparent.service` listening on `127.0.0.1:1081` with `-E --oob 1+s --auto=torst`.
3. **SOCKS5 Proxy**: `byedpi-socks.service` listening on `127.0.0.1:1080` with `--oob 1+s --auto=torst`.
4. **Iptables NAT Redirection**: `byedpi-nat.service` running `/usr/local/sbin/byedpi-nat.sh` (redirects outbound 80/443 to 1081 with CIDR exclusions).

---

## TCP Out-of-Band (OOB) Desync Strategy

Workstations use the following optimal strategy:
```bash
ciadpi -i 127.0.0.1 -p 1081 -E --oob 1+s --auto=torst
```

- **`--oob 1+s`**: Splits the TLS `ClientHello` 1 byte after the SNI offset and marks that single byte with the TCP Urgent Pointer (`URG`) flag.
  - TSPU reassembly hardware cannot reassemble streams carrying out-of-order urgent data pointers and fails inspection open.
  - Standard destination servers (RFC 793 / RFC 6093) consume/ignore the out-of-band byte and parse the authentic SNI.
- **`--auto=torst`**: Adaptive fallback. Initial TCP connections establish normally. Only if TSPU injects a TCP RST does `ciadpi` activate the desync strategy, caching the requirement per destination IP.

---

## Critical Incompatibility: Akamai CDN & Quay.io Registry

### The Problem
Akamai CDN edge servers (`23.0.0.0/8`, serving `cdn01.quay.io`, Apple CDN, GitHub asset downloads, etc.) employ strict stateful TCP filtering at their edge. **Akamai servers drop TCP segments containing the Urgent Pointer (`URG`) flag.**

If an HTTPS request to an Akamai IP has `--oob 1+s` applied:
1. Akamai silently drops the packet containing the urgent byte.
2. The TLS handshake hangs for 10 seconds before failing with `net/http: TLS handshake timeout` or `curl: (28) Connection timed out`.
3. In Kubernetes / Docker, pulls from `quay.io` (e.g. `quay.io/metallb/controller`, `quay.io/metallb/speaker`) fail with `ImagePullBackOff`.

### The Resolution
Quay.io and Akamai CDN are **not blocked upstream** by Russian ISP DPI. Desync is completely unnecessary for them.

In `/usr/local/sbin/byedpi-nat.sh`, Akamai's primary prefix (`23.0.0.0/8`) is explicitly bypassed from iptables NAT redirection:
```bash
for c in 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 224.0.0.0/4 100.64.0.0/10 23.0.0.0/8; do
  iptables -t nat -C OUTPUT -d "$c" -j RETURN 2>/dev/null || iptables -t nat -I OUTPUT -d "$c" -j RETURN
done
```
Traffic to Akamai traverses the gateway naked without entering `ciadpi`, achieving full gigabit wire-speed downloads without timeouts.

---

## Operator Commands

```bash
# Converge byedpi on all untrusted workstations
just byedpi

# Converge byedpi on a specific node
just byedpi beefyboi

# Verify service status on host
ssh beefyboi "systemctl status byedpi-transparent byedpi-nat byedpi-socks"

# Verify DPI bypass against blocked endpoints
ssh beefyboi "curl -Iv https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg"
ssh beefyboi "curl -sI https://cdn01.quay.io | head -n 5"
```
