# platform/proxmox

OpenTofu root for homelab compute virtualization on Proxmox VE using the
[`bpg/proxmox`](https://registry.terraform.io/providers/bpg/proxmox/latest/docs) provider.

Provisions a standardized cloud-init Docker VM on bare-metal Proxmox hardware using
modern virtualization defaults and the latest Ubuntu LTS release (**Ubuntu 24.04 LTS Noble Numbat**).
Once provisioned, configuration management is handed off to Ansible (`fleet/`).

## Architecture

```text
Physical Host (Proxmox VE 8.x)
  └─ OpenTofu (platform/proxmox)
       ├─ Downloads Ubuntu 24.04 LTS minimal cloud image (proxmox_download_file)
       └─ Deploys Docker Host VM (proxmox_virtual_environment_vm)
            ├─ Modern Q35 chipset + virtio-scsi-single + io_uring AIO
            ├─ VirtIO multiqueue networking + VirtIO RNG device
            └─ Cloud-init sets up admin user + SSH key
                 └─ Ansible (fleet/playbooks/host.yml) converges Docker + Tailscale
```

## Hardware Virtualization Defaults

- **OS**: Ubuntu 24.04 LTS (Noble Numbat) minimal cloud-init image (~350MB base).
- **Machine Type**: `q35` (Modern PCIe bus layout).
- **SCSI Controller**: `virtio-scsi-single` (Dedicated controller queue per virtual disk).
- **Async I/O Engine**: `io_uring` (Modern Linux asynchronous I/O engine for maximum NVMe/SSD IOPS).
- **Storage Flags**: `discard = "on"` (TRIM pass-through) and `ssd = true` (Flash scheduling).
- **CPU**: `type = "host"` (Passes all host CPU flags including AES-NI and vector extensions).
- **Network**: VirtIO multi-queue (`queues = var.vm_cores`) with Proxmox firewall integration.
- **Entropy**: Dedicated VirtIO RNG device (`/dev/urandom`) to eliminate guest entropy exhaustion during boot and SSH key generation.
- **Serial Console**: Built-in serial device for out-of-band `qm terminal` and Proxmox xterm.js access.

## Prerequisites

1. **Proxmox VE 8.x** running and accessible over your local network or Tailscale.
2. **Proxmox API Token**:
   - In the Proxmox web UI, navigate to **Datacenter -> Permissions -> API Tokens**.
   - Create a token for a user (e.g., `terraform@pve`, Token ID: `token`).
   - Grant appropriate permissions (e.g. `PVEVMAdmin` role or custom permissions for VM lifecycle and storage content upload).
   - Note the Secret Key (it will only be shown once).
3. **Datastores**:
   - `datastore_iso`: storage supporting `ISO image` content type (default `local`).
   - `datastore_vm`: storage supporting `Disk image` content type (default `local-lvm`).

## Quickstart

```bash
cd platform/proxmox

# 1. Copy example tfvars
cp envs/prod.tfvars.example envs/prod.tfvars

# 2. Edit envs/prod.tfvars with your Proxmox endpoint, token, and SSH key
chmod 600 envs/prod.tfvars

# 3. Plan (or use `just plan proxmox` from repo root)
tofu init
tofu plan -var-file=envs/prod.tfvars

# 4. Apply (human-run only)
tofu apply -var-file=envs/prod.tfvars
```

Alternatively, credentials can be set via environment variables in a gitignored `.envrc`:
```bash
export PROXMOX_VE_ENDPOINT="https://192.168.1.100:8006/"
export PROXMOX_VE_API_TOKEN="terraform@pve!token=00000000-0000-0000-0000-000000000000"
export PROXMOX_VE_INSECURE="true"
```

## Handoff to Ansible

When OpenTofu finishes applying:
1. The VM will boot and cloud-init will configure user `treau` with your SSH key.
2. Note the VM's IP address from `tofu output ipv4_addresses` or the Proxmox UI.
3. Add the node to `fleet/inventory/prod.yml`:
   ```yaml
   untrusted: # or homelab group
     hosts:
       homelab-1:
         ansible_host: 192.168.1.50
         ansible_user: treau
   ```
4. Run host convergence to install Docker, Tailscale, and firewall hardening:
   ```bash
   just converge homelab-1
   ```
5. Once joined to the tailnet, switch `ansible_host` in inventory to the Tailscale MagicDNS name or 100.x IP.

## State

State is local (`terraform.tfstate`) and gitignored. Keep it permissions `0600` and back it up off-machine.
