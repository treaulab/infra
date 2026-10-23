# treaulab/infra

Infrastructure-as-code for everything `treau.me` runs: the static site on the
Azure VPS, the `go.treau.me` tunnel Worker, and the private homelab.

## Architecture

```text
treau.me / www  ── Cloudflare ──> Azure VPS Caddy ──> static website only
go.treau.me     ── Cloudflare ──> Worker ──────────> /t/* HTTP + /p/* SSH pipes
homelab          ── Tailscale only ──> laptop / tailnet devices
later: selected homelab service ── Cloudflare Tunnel ──> cloudflared
```

The VPS is the main website origin, not a homelab proxy. The Worker is
tunnel-only and never bundles the site. Homelab services stay private on the
tailnet; Cloudflare Tunnel is an optional later ingress for selected services.

## Layout

```text
platform/          OpenTofu roots
├── azure/         Azure VPS (RG/VNet/NSG/PIP/NIC/VM)
├── cloudflare/    zone lookup (DNS records adopted incrementally)
├── github/        branch protection
├── tailscale/     tailnet ACL + CI keys/secrets
└── proxmox/       deferred: homelab compute as code

fleet/             Ansible: OS hardening, Tailscale, Docker
stacks/
├── public/        Azure VPS: caddy/ + website/src
├── homelab/       private apps/core stacks (Tailscale only)
└── nat-box/       existing NAT'd cloudflared host

edge/
└── tunnel-worker/ Cloudflare Worker on go.treau.me (tunnel-only)

tools/             operator helpers invoked by the Justfile
docs/runbooks.md   ops manual
Justfile           single operator interface
```

## Quickstart

```bash
cp platform/azure/envs/prod.tfvars.example platform/azure/envs/prod.tfvars
cp fleet/inventory/prod.yml.example fleet/inventory/prod.yml
cp stacks/public/caddy/.env.example stacks/public/caddy/.env
# fill the three files; .env files are gitignored

just setup                 # checks tools + installs Ansible collections
just plan azure            # read-only
just converge vps          # OS hardening + Tailscale + Docker
just deploy-public         # Caddy + static site to the VPS
```

If the VPS already exists, skip `just plan azure`; import later if you want
state coverage. The NSG must allow `22/tcp` (your IP), `80/tcp`, `443/tcp`.
Keep port 22 until Tailscale access is proven.

## Deploy paths

| Change | Command | Destination |
|---|---|---|
| `stacks/public/**` | `just deploy-public` | Azure VPS |
| `edge/tunnel-worker/**` | `cd edge/tunnel-worker && npm run deploy` / `tunnel.yml` | Cloudflare |
| `stacks/homelab/<app>/**` | `just deploy-home <app>` | Homelab over Tailscale |
| `platform/**` | `just plan <root>` | OpenTofu (human apply) |
| `fleet/**` | `just converge <node>` | OS configuration |

Website-only changes are rsync'd without restarting Caddy; Caddyfile/compose
changes recreate the container.

## Homelab access

The homelab VM joins the tailnet and is reached at its MagicDNS name or
`100.x` address. There is no public DNS or homelab ingress yet. Use
`tailscale serve` for HTTPS on the tailnet if an app needs it. Cloudflare
Tunnel is a later, separate path; it must not route through Azure Caddy.

## Secrets and state

- Per-stack `.env` files are plaintext and gitignored. Commit `.env.example`
  only. This is a deliberate temporary tradeoff; SOPS/age was removed.
- OpenTofu state is local for now. Back it up off-machine, keep state mode
  `0600`, and never apply after moving directories until `tofu plan` is empty.
  `platform/tailscale/terraform.tfstate` contains a live key — treat it as a
  secret.

## Tunnel Worker

```bash
cd edge/tunnel-worker && npm install
npm run dev       # http://127.0.0.1:8787
npm run deploy    # wrangler login required
```

Details: `edge/tunnel-worker/README.md`.
