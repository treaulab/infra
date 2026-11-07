# fleet

Ansible owns host OS baseline and Docker Compose convergence. CI builds artifacts;
Ansible only syncs configuration and converges compose projects.

```bash
cp inventory/prod.yml.example inventory/prod.yml   # gitignored
just converge              # Full fleet: OS baseline + compose stacks (site.yml)
just converge beefyboi     # Scope to a single host or group
just deploy-public         # Converge Caddy + static website on VPS (edge group)
```

## Structure

```
fleet/
├── ansible.cfg              # Default inventory, pipelining, sudo settings
├── group_vars/              # Scenario-scoped capability opt-ins & configs
│   ├── all.yml              # Global vars & zero-assumption baseline (all capabilities false)
│   ├── edge.yml             # VPS: ufw, fail2ban, ssh_hardening, docker, tailscale
│   ├── hypervisors.yml      # Hypervisor: enable_proxmox_host=true (pve repos, storage snippets, tofu role)
│   ├── cluster.yml          # K3s nodes: ufw, fail2ban, ssh_hardening, tailscale, k3s, lan_allow
│   ├── routers.yml          # Gateway router: ufw, fail2ban, ssh_hardening, tailscale, lan_allow
│   └── untrusted.yml        # Shared workstations: byedpi, docker, tailscale (tag:untrusted)
├── inventory/
│   ├── prod.yml             # Live inventory — flat scenario groups + host connection vars
│   └── prod.yml.example     # Reference template
├── playbooks/
│   ├── site.yml             # Full convergence: host.yml → compose.yml
│   ├── host.yml             # OS baseline — opt-in roles gated by capability flags
│   └── compose.yml          # Converge inventory-declared compose stacks
└── roles/
    ├── common/              # Packages, sudoers, unattended-upgrades, journald, apt prune
    ├── ufw/                 # Host firewall (opt-in)
    ├── fail2ban/            # Brute-force protection for exposed ports
    ├── docker/              # Docker Engine + weekly prune cron
    ├── tailscale/           # Tailscale install + tailnet join
    ├── byedpi/              # DPI circumvention proxy (untrusted workstations)
    ├── k3s/                 # K3s server + agent convergence
    ├── proxmox_host/        # Proxmox VE hypervisor baseline (repos, storage, OpenTofu role/token)
    └── compose_stack/       # Universal Docker Compose stack convergence
```

## Fleet Capability Matrix

The fleet is partitioned into capability tiers defined entirely in `fleet/group_vars/` as an **opt-in capability matrix**. `all.yml` defaults all capabilities to `false`; each scenario group explicitly opts into the capabilities it needs.

| Capability / Role | `edge` (`vps`) | `hypervisors` (`entia`) | `cluster` (`mercury`, `venus`, `earth`) | `routers` (`i`) | `untrusted` (`beefyboi`, `scrawnyboi`, `nucboi`) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Common Baseline** (`roles/common`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **PVE Hypervisor** (`roles/proxmox_host`) | ❌ | ✅ | ❌ | ❌ | ❌ |
| **UFW Firewall** (`roles/ufw`) | ✅ (22, 80, 443) | ❌ | ✅ (22 + LAN) | ✅ (22 + LAN) | ❌ |
| **Fail2ban** (`roles/fail2ban`) | ✅ | ❌ | ✅ | ✅ | ❌ |
| **SSH Hardening** (Keys only, no X11) | ✅ | ❌ | ✅ | ✅ | ❌ |
| **Docker Engine** (`roles/docker`) | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Tailscale Node** (`roles/tailscale`) | ✅ (unshared) | ❌ | ✅ | ✅ (gateway) | ✅ (`tag:untrusted`) |
| **ByeDPI Desync Proxy** (`roles/byedpi`) | ❌ | ❌ | ❌ | ❌ | ✅ (ISP bypass) |
| **K3s Engine** (`roles/k3s`) | ❌ | ❌ | ✅ (`mercury`=server, workers) | ❌ | ❌ |
| **Workload Convergence** | Caddy / Public Site | Proxmox VMs | K3s Cluster Manifests | Subnet Router | Docker Compose (`jellyfin`, ...) |

## Playbooks

- `playbooks/site.yml`: Full fleet convergence in one shot. Imports `host.yml` then `compose.yml`.
- `playbooks/host.yml`: OS baseline for all nodes conditioned on the capability matrix flags (`enable_ufw`, `enable_fail2ban`, `enable_ssh_hardening`, `enable_byedpi`, `enable_k3s`). Export `TAILSCALE_AUTHKEY` for non-interactive tailnet join.
- `playbooks/compose.yml`: Converges all `compose_stacks` declared in inventory. Syncs static website source on `edge` hosts before stack convergence.
