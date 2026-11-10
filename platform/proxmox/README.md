# platform/proxmox

OpenTofu root for homelab compute virtualization on Proxmox VE 9.x (Debian 13) using the
[`bpg/proxmox`](https://registry.terraform.io/providers/bpg/proxmox/latest/docs) provider.

Provisions standardized cloud-init K3s cluster virtual machines on the bare-metal Proxmox host (`entia`)
using modern virtualization defaults and **Ubuntu 26.04 LTS ("Resolute Raccoon")** minimal cloud images.
Once provisioned, Kubernetes cluster lifecycle and host configuration are handed off to Ansible (`fleet/`).

## Architecture

```text
Physical Host (Proxmox VE 9.x — entia)
  └─ OpenTofu (platform/proxmox)
       ├─ Downloads Ubuntu 26.04 minimal cloud image to local datastore (proxmox_download_file)
       ├─ Streams cloud-init vendor-data for qemu-guest-agent (proxmox_virtual_environment_file)
       └─ Deploys K3s Cluster VMs on local-zfs (proxmox_virtual_environment_vm)
            ├─ mercury (VM 500, 192.168.10.11/24) — K3s Control Plane Server
            ├─ venus through pluto (VM 501–508, 192.168.10.13–.27) — K3s Worker Nodes
            │    ├─ Modern Q35 PCIe chipset + virtio-scsi-single + io_uring AIO
            │    ├─ VirtIO multiqueue networking + VirtIO RNG device + NUMA
            │    ├─ Memory ballooning (floating min RAM to reclaim idle host memory)
            │    ├─ Automated startup sequencing (on_boot = true)
            │    └─ Cloud-init sets up admin user `treau` + SSH key + dynamic DNS
            └─ Ansible (fleet/roles/k3s via `just k3s`) converges K3s cluster & fetches kubeconfig
```

## Secrets and Authentication

Following repository policy, provider API credentials are **never** stored in `.env`, `variables.tf`, or `tfvars`. They are loaded into the shell from the gitignored `.envrc` via `direnv` (see `.envrc.example`):

```bash
export PROXMOX_VE_ENDPOINT="https://192.168.10.10:8006/"
export PROXMOX_VE_API_TOKEN="terraform@pve!tofu-token=00000000-0000-0000-0000-000000000000"
export PROXMOX_VE_INSECURE="true"
```

## Prerequisites

1. **Proxmox VE 9.x** running and accessible on `192.168.10.10:8006` or over the local network.
2. **Proxmox API Token**:
   - Automated via `fleet/roles/proxmox_host` (`just converge-pve`), which mints `terraform@pve!tofu-token` with the custom `Terraform` role.
   - Credentials load into your gitignored `.envrc` (`direnv allow .`).
3. **Datastores**:
   - `datastore_iso`: storage supporting `snippets,iso,vztmpl,backup,import` (default: `local`).
   - `datastore_vm`: ZFS pool supporting `images` content type (default: `local-zfs`).

## Quickstart

All VM fleet definitions live right at the top of `platform/proxmox/main.tf` in the `locals.vms` block. No `.tfvars` file or `-var-file` flags needed.

```bash
# 1. Ensure provider credentials are loaded in your shell via direnv:
#    cp .envrc.example .envrc && chmod 600 .envrc && direnv allow .

# 2. Plan via Justfile
just plan proxmox

# 3. Apply (human-run only)
tofu -chdir=platform/proxmox apply
```

## Handoff to Ansible

When OpenTofu finishes applying:
1. The VMs will boot and cloud-init will configure user `treau` with your SSH key and static IPs.
2. Nodes are pre-configured in `fleet/inventory/prod.yml` under group `cluster:`.
3. Converge K3s control plane and workers:
   ```bash
   just k3s
   ```
4. Verify cluster status:
   ```bash
   just k get nodes
   ```

## State

State is local (`terraform.tfstate`) and gitignored. Keep it permissions `0600` and back it up off-machine.
