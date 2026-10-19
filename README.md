# treaulab/infra

Organized IaC for 1x Azure VPS (Ubuntu 24.04) — the **main server**: static
website behind Caddy on `treau.me` (Cloudflare-proxied, auto-deployed on main)
— plus a Cloudflare Worker that serves HTTP/SSH tunnels on `go.treau.me`
(agents dial out; the VPS is never in the tunnel data path).

## Architecture

```
treau.me / www — Cloudflare proxy → Azure VPS (MAIN; deploy.yml auto-deploys)
├── Caddy :80/:443 (auto-TLS front door)
└── Website (static, via Caddy file_server; source of truth apps/website/src)

go.treau.me — Cloudflare Worker (treaulab-tunnel; tunnel.yml auto-deploys)
└── /t/* HTTP tunnels + /p/* SSH pipes (Durable Objects; no origin fetch)
```

## Layout

```
tofu/                  L1: Azure RG/VNet/NSG/IP/VM (imports existing VPS)
tofu/cloudflare/       DNS: zone lookup now, records as code next (import-first)
ansible/               L2: hardening, docker, caddy, website
apps/caddy/            compose + Caddyfile
apps/website/          static src (single source: to VPS via deploy.sh, to worker via sync:public)
apps/cloudflared/        NAT box (behind NAT, VPS-untouched): cloudflared HTTP+SSH on treau.me subs
workers/tunnel/          Tunnel Worker: HTTP tunnel + TCP pipe Durable Objects on go.treau.me
scripts/               bootstrap.sh, deploy.sh
.github/workflows/    tofu.yml, ci.yml, tunnel.yml, deploy.yml, agent-bin.yml
docs/runbooks.md       first boot, backups, upgrades, optional apex cutover, NAT box
```

## Quickstart

VPS already up? **Skip step 4** (OpenTofu) — it's optional when the VM exists.
Just open these ports on your Azure NSG (portal → VM → Networking):
`22/tcp` (your IP only), `80/tcp`, `443/tcp`, then start at step 5.
Keep `tofu/` as documentation; import the existing resources into state later
once the VPS is stable (see `docs/runbooks.md`).

1. `cp tofu/envs/prod.tfvars.example tofu/envs/prod.tfvars` — fill RG, location
2. `cp ansible/inventory/prod.yml.example ansible/inventory/prod.yml` — fill `ansible_host`, `ansible_user`
3. Provision — OPTIONAL if VPS exists (import existing, don't recreate):
   ```bash
   ./scripts/bootstrap.sh
   cd tofu && tofu init && tofu plan -var-file=envs/prod.tfvars
   ```
4. Configure — pick one:
   * Quick (no installs needed, just ssh+rsync):
     ```bash
     ./scripts/deploy.sh prod
     ```
   * Full (adds hardening: UFW, fail2ban, unattended-upgrades — needs ansible, NixOS: `nix-shell -p ansible`):
     ```bash
     ansible-playbook -i ansible/inventory/prod.yml ansible/playbooks/site.yml
     ```

See `docs/runbooks.md`. Secrets: `.env` (gitignored) + `ansible-vault` + GH Secrets (`SSH_PRIVATE_KEY, SSH_HOST, SSH_USER, SITE_DOMAIN, ACME_EMAIL` for the VPS; `CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID` for the worker).

## Tunnel Worker (HTTP tunnels + SSH pipes on go.treau.me)

The main site stays on the VPS; the Worker serves the tunnels + pipes.

```bash
cd workers/tunnel && npm install
npm run dev                      # local: http://127.0.0.1:8787 (no secrets)
npm run deploy                   # needs wrangler login only (long-URL, no tokens)
```

Details: `workers/tunnel/README.md`. The apex cutover onto the Worker is an
optional, unexecuted migration — `docs/runbooks.md`.
