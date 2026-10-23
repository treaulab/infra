# dpi-bypass

Installs [byedpi](https://github.com/hufrea/byedpi) from the official upstream
repository and runs it as an unprivileged local service. It is meant for hosts
on networks that interfere with TLS/HTTP, not for the public VPS.

The role deliberately does **not** use the Codeberg mirror or any fallback
repository. The release asset and source tag are pinned, and the release tarball
is verified with SHA256 before it is copied to the target.

## What it creates

| Piece | Default |
| --- | --- |
| `byedpi-socks.service` | SOCKS5 on `127.0.0.1:1080` |
| `byedpi-transparent.service` | transparent proxy on `127.0.0.1:1081` |
| `byedpi-nat.service` | IPv4 `iptables` redirect for TCP `80`/`443` |
| privoxy | HTTP proxy on `127.0.0.1:8118` -> SOCKS5 |
| system user | `byedpi` (no login, no home) |
| binary | `/usr/local/bin/ciadpi` |

The desync defaults match the original installer:
`--oob 1+s --auto=torst`.

`dpi_bypass_enable_transparent: true` is full-device mode: outbound TCP 80/443
is redirected through the transparent proxy, and QUIC UDP/443 is rejected so
browsers fall back to TCP. Set it to `false` to keep only the SOCKS5 and HTTP
listeners and let applications opt in via `ALL_PROXY` / `HTTPS_PROXY`.

The NAT rules use dedicated `BYEDPI_NAT` and `BYEDPI_QUIC` chains, so they can
be flushed and rebuilt cleanly. Loopback, private networks, link-local,
multicast, and Tailscale `100.64.0.0/10` are excluded by default; traffic from
the `byedpi` user is excluded to prevent a redirect loop.

## Usage

Add the host to the `restricted` group in `fleet/inventory/prod.yml`, then:

```bash
just unblock restricted-laptop
```

Remove everything the role installed:

```bash
just unblock-off restricted-laptop
```

Only hosts explicitly placed in `restricted` are touched. Never add the public
VPS or a host whose inbound path depends on the proxy.

If the target cannot reach GitHub, download the pinned tarball on a machine that
can and pass its controller-side path:

```bash
DPI_BYPASS_ARTIFACT=/tmp/byedpi-17.3-x86_64.tar.gz just unblock restricted-laptop
```

The role still verifies the SHA256 before copying it. By default the release is
downloaded on the Ansible controller (not the target), then copied over SSH.

## Verification

```bash
ssh restricted-laptop
sudo systemctl status byedpi-socks byedpi-transparent byedpi-nat privoxy
ss -lntp | grep -E ':(1080|1081|8118)\b'
curl -x socks5h://127.0.0.1:1080 -I https://example.com
curl -x http://127.0.0.1:8118 -I https://example.com
sudo iptables -t nat -S BYEDPI_NAT
sudo iptables -S BYEDPI_QUIC
```

From another machine, confirm the public egress IP is unchanged by the bypass
itself; byedpi is a local proxy, not a VPN.

## Variables worth changing

| Variable | Default | Notes |
| --- | --- | --- |
| `dpi_bypass_install_method` | `release` | `source` builds the pinned tag; needs `build-essential`/`git`. |
| `dpi_bypass_version` | `0.17.3` | Must match the asset map and the upstream tag. |
| `dpi_bypass_desync_opts` | `--oob 1+s --auto=torst` | Passed to both services. |
| `dpi_bypass_enable_transparent` | `true` | `false` = proxy-only listeners. |
| `dpi_bypass_block_quic` | `true` | Reject UDP/443 to force TCP fallback. |
| `dpi_bypass_privoxy` | `true` | HTTP proxy in front of SOCKS5. |
| `dpi_bypass_exclude_cidrs` | private + Tailscale ranges | Keep Tailscale reachable. |
| `dpi_bypass_extra_exclude_cidrs` | `[]` | Add local egress, e.g. a cloudflared host. |
| `dpi_bypass_service_capabilities` | `[]` | Set `["CAP_NET_ADMIN"]` only for `--md5sig`. |
| `dpi_bypass_remove_privoxy_package` | `false` | On `state=absent`, also purge privoxy. |

To upgrade, bump `dpi_bypass_version`, update the asset names/SHA256s from the
upstream release, and run the playbook again. To switch to a source build:

```bash
cd fleet
ansible-playbook -i inventory/prod.yml playbooks/unblock.yml \
  --limit restricted-laptop -e dpi_bypass_install_method=source
```

## Limitations and safety

- **IPv4 only.** The role does not add `ip6tables` rules. If the host has a
  working IPv6 default route, extend the role before relying on full coverage.
- **Host networking only.** Docker bridge/NAT traffic is not redirected by the
  host's `OUTPUT` chain; containers can egress directly.
- **TCP 80/443 only.** Non-HTTP TCP and UDP are not proxied. QUIC is blocked,
  not proxied.
- **UFW reloads.** `byedpi-nat.service` is `PartOf=ufw.service`, so a normal
  `systemctl restart ufw` reapplies the rules. If you use `ufw reload` directly,
  run `systemctl restart byedpi-nat` afterward.
- **Cloudflare Tunnel / local agents.** If a tunnel or agent runs on the same
  host, add its egress CIDRs to `dpi_bypass_extra_exclude_cidrs` to avoid a
  loop. Adding the VPS to `restricted` is not supported.
- **CAP_NET_ADMIN.** Default desync options do not need it. `--md5sig` does;
  set `dpi_bypass_service_capabilities: ["CAP_NET_ADMIN"]`.
- **State removal.** `dpi_bypass_state=absent` stops the services, removes the
  redirect chains, deletes the binary/units/user, and removes the privoxy lines
  added by this role. The privoxy package is kept unless
  `dpi_bypass_remove_privoxy_package=true`.
