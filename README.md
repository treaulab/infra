# treaulab/infra

Organized IaC for 1x Azure VPS (Ubuntu 24.04) running a static website behind Caddy.

## Architecture

```
Azure VPS
├── Caddy :80/:443 (auto-TLS, front door)
└── Website (static, via Caddy file_server)
```

## Layout

```
tofu/                  L1: Azure RG/VNet/NSG/IP/VM (imports existing VPS)
ansible/               L2: hardening, docker, caddy, website
apps/caddy/            compose + Caddyfile
apps/website/          static src + compose
scripts/               bootstrap.sh, deploy.sh
.github/workflows/    tofu.yml, deploy.yml
docs/runbooks.md       first boot, backups, upgrades
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

See `docs/runbooks.md`. Secrets: `.env` (gitignored) + `ansible-vault` + GH Secrets (`SSH_PRIVATE_KEY, SSH_HOST, SSH_USER`).
