# fleet

Ansible owns OS state only: base hardening, Tailscale, Docker, and an opt-in
DPI bypass for hosts in restricted networks. Container lifecycles belong to
`Justfile` + `tools/deploy-*.sh`; there is deliberately no Caddy role.

```bash
cp inventory/prod.yml.example inventory/prod.yml   # gitignored
just bootstrap vps     # base + Tailscale
just docker vps        # Docker only
just converge vps      # all roles
just unblock restricted-laptop   # byedpi full-device DPI bypass
just unblock-off restricted-laptop
```

`site.yml` = base + tailscale + docker. Export `TAILSCALE_AUTHKEY` for a
non-interactive `tailscale up`; otherwise the role installs Tailscale and
prints the manual join command. The homelab host is addressed over its
MagicDNS name / `100.x` address.

`unblock.yml` only targets the explicit `restricted` inventory group. The
`dpi-bypass` role pins official upstream byedpi, verifies the release SHA256,
and keeps SOCKS5 (`1080`), transparent (`1081`), and privoxy (`8118`) on
loopback. See `roles/dpi-bypass/README.md` for variables, verification, and
IPv4/QUIC limitations.
