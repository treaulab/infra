# tools

Operator helpers invoked by the root `Justfile`. They are implementation
details, not a second interface: use `just ...`.

- `deploy-public.sh` — rsync `stacks/public/` to the Azure VPS + compose.
- `deploy-home.sh` — rsync one `stacks/homelab/{apps,core}/<app>` over Tailscale.
- `bump-spoke.sh` — pin a tailnet-runner spoke to a hub SHA.
- `gh-shell.sh` — dispatch a tailnet runner and SSH in.
