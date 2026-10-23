# fleet

Ansible owns OS state only: base hardening, Tailscale, and Docker. Container
lifecycles belong to `Justfile` + `tools/deploy-*.sh`; there is deliberately no
Caddy role.

```bash
cp inventory/prod.yml.example inventory/prod.yml   # gitignored
just bootstrap vps     # base + Tailscale
just docker vps        # Docker only
just converge vps      # all roles
```

`site.yml` = base + tailscale + docker. Export `TAILSCALE_AUTHKEY` for a
non-interactive `tailscale up`; otherwise the role installs Tailscale and
prints the manual join command. The homelab host is addressed over its
MagicDNS name / `100.x` address.
