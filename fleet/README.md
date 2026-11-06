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
├── group_vars/              # Group-scoped capability flags & configs
│   ├── all.yml              # Global vars (domain, site_ip, deploy_root, base_ufw_ports)
│   ├── trusted.yml          # Servers: UFW on, fail2ban on, SSH hardened, byedpi off
│   ├── internal.yml         # LAN servers: no public ports (LAN + Tailscale allowed)
│   ├── cluster.yml          # K3s nodes: enable_k3s=true, token, SANs
│   ├── edge.yml             # VPS: base_ufw_ports, caddy_env_content
│   └── untrusted.yml        # Workstations: UFW off, fail2ban off, SSH relaxed, byedpi on
├── inventory/
│   ├── prod.yml             # Live inventory — hosts + connection vars only
│   └── prod.yml.example     # Reference template
├── playbooks/
│   ├── site.yml             # Full convergence: host.yml → compose.yml
│   ├── host.yml             # OS baseline — common, ufw, fail2ban, docker, tailscale, byedpi, k3s
│   └── compose.yml          # Converge inventory-declared compose stacks
└── roles/
    ├── common/              # Packages, sudoers, unattended-upgrades, journald, apt prune
    ├── ufw/                 # Host firewall (servers only)
    ├── fail2ban/            # Brute-force protection for exposed ports
    ├── docker/              # Docker Engine + weekly prune cron
    ├── tailscale/           # Tailscale install + tailnet join
    ├── byedpi/              # DPI circumvention proxy (untrusted workstations)
    ├── k3s/                 # K3s server + agent convergence
    ├── website/             # Static site file sync (edge hosts)
    └── compose_stack/       # Universal Docker Compose stack convergence
```

## Fleet Capability Matrix

The fleet is partitioned into capability tiers defined entirely in `fleet/group_vars/`. `prod.yml` only declares host connection details and specific workloads.

| Capability / Role | `edge` (`vps`) | `internal.cluster` (`mercury`, `venus`, `earth`) | `internal.routers` (`i`) | `untrusted` (`beefyboi`, `scrawnyboi`, `nucboi`) |
| :--- | :---: | :---: | :---: | :---: |
| **Common Baseline** (`roles/common`) | ✅ | ✅ | ✅ | ✅ |
| **Docker Engine & Prune** (`roles/docker`) | ✅ | ✅ | ✅ | ✅ |
| **Tailscale Node** (`roles/tailscale`) | ✅ (unshared) | ✅ | ✅ (gateway) | ✅ (`tag:untrusted`) |
| **UFW Firewall** (`roles/ufw`) | ✅ (22, 80, 443) | ✅ (22 + LAN) | ✅ (22 + LAN) | ❌ (disabled) |
| **Fail2ban** (`roles/fail2ban`) | ✅ | ✅ | ✅ | ❌ (disabled) |
| **SSH Hardening** (Keys only, no X11) | ✅ | ✅ | ✅ | ❌ (workstation defaults) |
| **ByeDPI Desync Proxy** (`roles/byedpi`) | ❌ | ❌ (uses router zapret2) | ❌ | ✅ (ISP bypass) |
| **K3s Engine** (`roles/k3s`) | ❌ | ✅ (`mercury`=server, workers) | ❌ | ❌ |
| **Workload Convergence** | Caddy / Public Site | K3s Cluster Manifests | Subnet Router | Docker Compose (`jellyfin`, ...) |

## Playbooks

- `playbooks/site.yml`: Full fleet convergence in one shot. Imports `host.yml` then `compose.yml`.
- `playbooks/host.yml`: OS baseline for all nodes conditioned on the capability matrix flags (`enable_ufw`, `enable_fail2ban`, `enable_ssh_hardening`, `enable_byedpi`, `enable_k3s`). Export `TAILSCALE_AUTHKEY` for non-interactive tailnet join.
- `playbooks/compose.yml`: Converges all `compose_stacks` declared in inventory. Syncs static website source on `edge` hosts before stack convergence.
