# fleet

Ansible owns OS state and host/compose convergence: base hardening, Tailscale,
Docker, the public Caddy stack, private homelab stacks, and an opt-in DPI
bypass for hosts in restricted networks. CI builds and publishes artifacts;
the deploy playbooks only sync source/config, pull images, and run compose.

```bash
cp inventory/prod.yml.example inventory/prod.yml   # gitignored
just bootstrap vps     # base + Tailscale
just docker vps        # Docker only
just converge vps      # all roles
just deploy-public     # Caddy + static site (edge group)
just deploy-home vaultwarden   # one homelab stack
just unblock restricted-laptop   # byedpi full-device DPI bypass
just unblock-off restricted-laptop
```

`site.yml` = base + tailscale + docker. Export `TAILSCALE_AUTHKEY` for a
non-interactive `tailscale up`; otherwise the role installs Tailscale and
prints the manual join command. The homelab host is addressed over its
MagicDNS name / `100.x` address.

`deploy-public.yml` targets the `edge` group (`vps` by default), templates the
Caddy `.env` from inventory variables, syncs the static site, and converges
the compose project. `deploy-home.yml` resolves `stacks/homelab/apps/<app>`
before `core/<app>`, syncs the stack with `rsync --delete`, and leaves app data
to named volumes or host paths outside the synced directory.

`tools/deploy-public.sh` and `tools/deploy-home.sh` are thin compatibility
wrappers for one transition cycle; the `just` recipes call Ansible directly.

`unblock.yml` only targets the explicit `restricted` inventory group. The
`dpi-bypass` role pins official upstream byedpi, verifies the release SHA256,
and keeps SOCKS5 (`1080`), transparent (`1081`), and privoxy (`8118`) on
loopback. See `roles/dpi-bypass/README.md` for variables, verification, and
IPv4/QUIC limitations.
