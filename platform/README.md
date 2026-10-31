# platform

Machine, network, DNS, identity, and governance control planes. Each directory
is an independent OpenTofu root with its own local state.

| Root | Manages |
|---|---|
| `azure/` | Azure RG/VNet/NSG/PIP/NIC/VM for the public VPS |
| `cloudflare/` | Zone lookup (records adopted incrementally) |
| `github/` | Branch protection for `treaulab/infra#main` |
| `proxmox/` | Homelab compute: cloud-init base image and Docker host VM on Proxmox VE |
| `tailscale/` | Tailnet ACL, tags, CI keys/secrets (legacy key path) |

State is local for now. Back it up off-machine, keep it mode 0600,
and never apply after a directory move until `tofu plan` is empty.
