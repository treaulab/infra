# Runbooks

## First boot (existing manual VPS -> IaC)

1. Confirm the Azure NSG allows `22/tcp` (your IP), `80/tcp`, `443/tcp`.
   Keep 22 open until Tailscale access is proven.
2. Copy and fill:
   ```bash
   cp platform/azure/envs/prod.tfvars.example platform/azure/envs/prod.tfvars
   cp fleet/inventory/prod.yml.example fleet/inventory/prod.yml
   # Caddy .env is rendered on the VPS by the deploy playbook.
   ```
3. If the VPS exists, skip `tofu apply`; adopt it later via `tofu import`
   once stable. Back up state first and review `tofu plan` so nothing is
   replaced.
4. Configure the host:
   ```bash
   just setup
   just converge vps          # base + Tailscale + Docker
   just deploy-public         # Caddy + static site
   ```
5. Verify: `curl -sI https://<domain>/` (200), `docker logs caddy --tail 20`.
6. Add the homelab host to `fleet/inventory/prod.yml` using its MagicDNS name
   or `100.x` address, then `just converge homelab`.

## Deploy / upgrade Caddy

- Website-only change: `just deploy-public`; Ansible syncs the site without
  restarting Caddy.
- Caddyfile change: same command; an Ansible handler recreates the container.
- Compose/`.env` change: same command; the compose convergence applies it
  (typically by recreating the container when its config hash changes).
- Version bump: update `caddy_version` in `fleet/inventory/prod.yml`, then
  `just deploy-public`. For a one-off, run the playbook with
  `-e caddy_version=...` (or use the compatibility wrapper, which still maps
  `CADDY_VERSION`). The playbook templates `stacks/public/caddy/.env` on the
  host from inventory variables.
- Check logs: `ssh <vps> 'docker logs caddy --tail 50'`.
- The `deploy-public` playbook also waits for `https://<domain>/` to return
  `200`; CI uses the same external check.

Caddy serves `/srv/website` from `stacks/public/website/src`. It has no
`reverse_proxy` blocks; homelab traffic does not transit the VPS.

## Backups

Caddy data lives in Docker named volumes (`caddy-data`, `caddy-config`).
Homelab app data should live in named volumes or host paths outside the
synced stack directory (deploy uses `rsync --delete`).

Example Caddy snapshot:

```bash
docker run --rm -v caddy-data:/data -v /opt/treaulab/backups:/backup ubuntu \
  tar -czf /backup/caddy-data-$(date +%F).tar.gz -C /data .
```

Keep backups off-machine. Back up homelab app data on its own schedule.

## Deploy a homelab stack

```bash
just deploy-home <app> [env]     # default env=prod
```

The playbook resolves `stacks/homelab/apps/<app>` before
`stacks/homelab/core/<app>`, syncs the stack with `rsync --delete`, and runs
`docker compose up -d --remove-orphans --pull always` through Ansible. Keep
mutable app data in named volumes or host paths outside the synced directory.
A local `.env` is copied separately with mode `0600`; it is excluded from
rsync so an absent local file does not delete the remote one.

`tools/deploy-home.sh <app> [env]` remains a compatibility wrapper for one
cycle. For a one-off health check, pass
`-e homelab_healthcheck_url=http://<host>:<port>/` directly to
`ansible-playbook`; the default deploy relies on Compose's `--wait`.

## Homelab access (Tailscale only)

- Join the homelab VM to the tailnet (`just converge homelab`, or run
  `tailscale up --hostname homelab-vm` manually). Use `--accept-dns=false` if
  the host runs AdGuard/its own DNS.
- Reach apps at the MagicDNS name or `100.x` address. `tailscale serve` can
  provide HTTPS on the tailnet:
  ```bash
  tailscale serve --bg 8222          # https://homelab.<tailnet>.ts.net
  tailscale serve status
  ```
- UFW allows the `tailscale0` interface via the `base` role. Public ports on
  the homelab are limited to 22 (`base_ufw_ports` in the inventory).
- Do not use Tailscale Funnel for private services.
- Cloudflare Tunnel is a later, optional ingress for selected services. It
  runs on the homelab or the NAT box and never routes through Azure Caddy.

## Restricted-network DPI bypass (byedpi)

For client hosts whose network interferes with TLS/HTTP. This is not for the
VPS or any public origin.

1. Add the host to the `restricted` group in `fleet/inventory/prod.yml`
   (gitignored). The group is empty by default and `unblock.yml` only targets it.
2. `just unblock <host>` installs official upstream byedpi, verifies the pinned
   release SHA256, and starts SOCKS5 `127.0.0.1:1080`, transparent `1081`, and
   privoxy `8118`. Full-device mode redirects the host's own TCP `80`/`443` and
   rejects QUIC UDP/443 by default.
3. Verify:
   ```bash
   ssh <host> 'sudo systemctl status byedpi-socks byedpi-transparent byedpi-nat privoxy'
   ssh <host> 'curl -x socks5h://127.0.0.1:1080 -I https://example.com'
   ssh <host> 'sudo iptables -t nat -S BYEDPI_NAT'
   ```
4. If the target cannot reach GitHub, pre-download the exact upstream asset and
   pass `DPI_BYPASS_ARTIFACT=/path/to/byedpi-17.3-<arch>.tar.gz just unblock <host>`.
5. Undo: `just unblock-off <host>` stops services and removes the redirect
   chains, units, binary, and role user.

Caveats: IPv4 only; Docker bridge traffic and UDP are not proxied; QUIC is
rejected, not proxied. Keep Tailscale in the exclusion list, and add local
tunnel/agent egress CIDRs to `dpi_bypass_extra_exclude_cidrs` to avoid loops.
`byedpi-nat.service` is `PartOf=ufw.service`; after a bare `ufw reload`, run
`systemctl restart byedpi-nat`. Full variables:
`fleet/roles/dpi-bypass/README.md`.

## NAT box (cloudflared, stable treau.me access)

Separate NAT'd host exposing HTTP + SSH on stable subdomains. It is not the
Proxmox homelab. Full runbook: `stacks/nat-box/cloudflared/README.md`.

1. On the NAT box: `./stacks/nat-box/cloudflared/install.sh --check-only`
   (outbound `7844/UDP` + `443/TCP`; inbound stays closed).
2. `cloudflared tunnel login && cloudflared tunnel create nat-box`, then
   `route dns nat-box box.treau.me` and `route dns nat-box ssh-box.treau.me`.
3. Copy `config.yml.example` to `/etc/cloudflared/config.yml`, fill the tunnel
   UUID (ingress `box` -> `http://localhost:8080`, `ssh-box` ->
   `ssh://localhost:22`, `http_status:404`).
4. Smoke test, then persist via `cloudflared.service.example` -> systemd.
5. Laptop SSH via `ssh-client.example` (`ProxyCommand cloudflared access ssh`).

## Tailnet shell (hub + ONE burner spoke repo, NOT on the VPS)

This repo is the **hub**: reusable logic, zero credentials, runs nothing
itself. A burner-owned **public** repo (`dotfiles`) fans out N tenants, one
calling job per tenant.

- Hub: `.github/workflows/tailnet-runner.yml` (`workflow_call`, inputs
  `mode` hourly|debug, `hostname-prefix`, `box-name`, `edge-url`, `quiet`,
  `startup-delay-seconds`, `tag`, `ts-oidc-client-id`/`ts-audience`; secrets
  `TS_OAUTH_*` or `TS_AUTHKEY_EPHEMERAL`).
- Spoke template: `.github/workflows/tailnet-runner-caller.yml.example`.
- Launcher: `./tools/gh-shell.sh [t1|t2]`.
- Bump pin: `./tools/bump-spoke.sh <owner/repo> <hub-sha>`.

1. Tailscale admin (once, preferred OIDC): Trust credentials -> OIDC federated
   identity, issuer `https://token.actions.githubusercontent.com`, subject
   `repo:<owner>@<owner-id>/<repo>@<repo-id>:*`, tags `tag:ci-ephemeral`,
   scope `auth_keys` write. Put Client ID + Audience in spoke repo VARIABLES.
   Access Controls: `tagOwners` for `tag:ci-ephemeral`, SSH accept from you to
   that tag, users `["runner","root"]`. Name the NAT box `box`.
2. Spoke repo (public dotfiles + README + caller file), pin
   `@<sha>`, set `TS_OIDC_CLIENT_ID`/`TS_AUDIENCE`. Legacy authkey path only
   if OIDC is unavailable.
3. Use: hourly schedule, or dispatch a tenant and `tailscale ssh` in.
4. Rollback per tenant: revoke its key/secret, sibling tenants untouched.
5. Warm-up (new accounts): human commits -> debug dispatches -> daily ->
   hourly. The VPS stays untouched.

Policy/keys root: `platform/tailscale`. Applies are human/terminal with
short-lived credentials; CI is fmt/validate only. The local state contains a
live key — see "OpenTofu state" below.

## Secrets (`.env`/`.envrc` local, hidden prompts for one-offs)

SOPS/age was removed for now. Plaintext local files are a deliberate
temporary tradeoff:

- `.env` is gitignored globally; commit `.env.example` only. It is for
  runtime stack config.
- `.envrc` is gitignored, mode `0600`, and loaded by `direnv` for local
  provider credentials:
  ```bash
  cp .envrc.example .envrc
  chmod 600 .envrc
  # fill in the values locally
  direnv allow .
  ```
  It is plaintext on disk. Move high-value tokens to GNOME Keyring
  (`secret-tool`) or 1Password when convenient. Never commit it.
- Caddy `.env` is non-secret (domain/email/version/IP).
- Homelab/app `.env` files may contain secrets: keep them mode `0600`, never
  log them, and never commit them. `just secrets-check` guards tracked
  `.env` and `.envrc`.
- One-off credentials can still be entered with a hidden prompt instead of
  `.envrc`; never put provider tokens in `.env` or tfvars:
  ```bash
  printf 'Cloudflare API token: '
  read -s CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
  echo
  ```
  Repeat the same pattern for `GITHUB_TOKEN`, `TAILSCALE_API_KEY`, or
  `TAILSCALE_OAUTH_CLIENT_SECRET`.
- Keep GitHub dynamic rather than storing a static token:
  ```bash
  GITHUB_TOKEN="$(gh auth token --user slancj)" just plan tailscale
  ```
- `deploy.yml` creates a CI inventory from GitHub Secrets; the
  `deploy-public` playbook templates the Caddy `.env` on the host.
- Do not paste secrets into chat or issue trackers. A future SOPS/age or
  Docker-secrets migration can replace this without changing stack layouts.

## OpenTofu state (local for now)

Every root under `platform/` uses local state, which is gitignored:

- Back up `terraform.tfstate` and `.backup` off-machine before any move.
- Keep state mode `0600` and its directory `0700`.
- Never run concurrent applies; CI only runs `fmt`/`validate`.
- After moving a root: move the state file with the code, delete the old
  `.terraform/` (absolute paths), run `tofu init` in the new root, then
  `tofu state list` and `tofu plan`. **Do not apply until the plan is empty.**
- `platform/tailscale/terraform.tfstate` holds a live tailnet key. Move it
  last, verify the checksum, and run `tofu state list`; run `tofu plan` as soon
  as the required credentials are available. Stop if the plan is not empty.
- A remote encrypted backend can come later; migrate `tailscale` first with
  `tofu init -migrate-state`.
