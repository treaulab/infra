# fleet

Ansible owns host OS baseline and Docker Compose convergence. CI builds artifacts;
Ansible only syncs configuration and converges compose projects.

```bash
cp inventory/prod.yml.example inventory/prod.yml   # gitignored
just converge vps          # Host OS baseline on VPS: UFW, Tailscale, Docker
just converge cluster      # Host OS baseline on Proxmox VMs
just k3s                   # Converge K3s cluster engine on mercury + venus + earth
just untrusted             # Host OS baseline on workstations (UFW disabled)
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
    ├── host.yml             # Unified OS baseline across all fleet hosts (UFW, Docker, Tailscale, ByeDPI)
    ├── k3s.yml              # Kubernetes cluster orchestration (mercury server + venus/earth agents)
    ├── deploy.yml           # Compose stack deployer (defaults to public Caddy stack)
    └── tasks/
        └── byedpi.yml       # Transparent ByeDPI circumvention (ciadpi + systemd + iptables NAT)
```

## Playbooks

- `playbooks/host.yml`: Unified Day-1 OS baseline for all nodes: base packages, Docker Engine, unattended upgrades, and Tailscale. Enforces UFW on `trusted` servers, and keeps UFW disabled on `untrusted` workstations. Automatically converges transparent `byedpi` on nodes with `enable_byedpi: true` (workstations subject to ISP DPI).
  Export `TAILSCALE_AUTHKEY` for non-interactive tailnet join.
- `playbooks/k3s.yml`: Installs and converges K3s cluster engine (`mercury` control plane, `venus` and `earth` worker agents). Runs via `just k3s`.
- `playbooks/deploy.yml`: Deploys Caddy + static website to the Azure VPS (targets `edge` group).
- `playbooks/tasks/byedpi.yml`: Standalone task file deploying `ciadpi` (v0.17.3), systemd units (`byedpi-transparent` on 1081, `byedpi-socks` on 1080, `byedpi-nat`), and iptables redirection. Runs standalone via `just byedpi [node]`.
