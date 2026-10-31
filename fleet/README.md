# fleet

Ansible owns host OS baseline and Docker Compose convergence. CI builds artifacts;
Ansible only syncs configuration and converges compose projects.

```bash
cp inventory/prod.yml.example inventory/prod.yml   # gitignored
just converge vps          # Host OS baseline on VPS: UFW, Tailscale, Docker
just converge homelab      # Host OS baseline on Proxmox homelab VM
just deploy-public         # Deploy Caddy + static website stack to VPS
```

## Structure

```
fleet/
├── ansible.cfg              # Default inventory, pipelining, sudo settings
├── inventory/
│   ├── prod.yml             # Live inventory (gitignored)
│   └── prod.yml.example     # Reference template
└── playbooks/
    ├── host.yml             # OS baseline: UFW hardening, Tailscale, Docker Engine
    ├── deploy.yml           # Compose stack deployer (defaults to public Caddy stack)
    └── templates/
        └── public-caddy.env.j2 # Rendered .env for Caddy
```

## Playbooks

- `playbooks/host.yml`: Sets up base packages, firewall (UFW), Tailscale, and Docker.
  Export `TAILSCALE_AUTHKEY` for non-interactive tailnet join.
- `playbooks/deploy.yml`: Deploys Caddy + static website to the Azure VPS (targets `edge` group).
