# kubernetes

Declarative Kubernetes state and workload management for the homelab K3s cluster.

## Cluster Topology

Virtual machines are provisioned on the Proxmox VE hypervisor (`entia`) via OpenTofu (`platform/proxmox/`) and converged via Ansible (`fleet/roles/k3s`):

| Node | Role | IP Address | Specs | Tags |
| :--- | :--- | :--- | :--- | :--- |
| **`mercury`** (VM 500) | Server (Control Plane + Etcd/SQLite) | `192.168.10.11` | 2 vCPU, 8GB RAM, 32GB disk | `k3s`, `control-plane` |
| **`venus`** (VM 501) | Agent (Worker Node) | `192.168.10.13` | 2 vCPU, 8GB RAM, 32GB disk | `k3s`, `worker` |
| **`earth`** (VM 502) | Agent (Worker Node) | `192.168.10.14` | 2 vCPU, 8GB RAM, 32GB disk | `k3s`, `worker` |
| **`mars`** (VM 503) | Agent (Worker Node) | `192.168.10.22` | 2 vCPU, 8GB RAM, 32GB disk | `k3s`, `worker` |
| **`jupiter`** (VM 504) | Agent (Worker Node) | `192.168.10.23` | 2 vCPU, 8GB RAM, 32GB disk | `k3s`, `worker` |
| **`saturn`** (VM 505) | Agent (Worker Node) | `192.168.10.24` | 2 vCPU, 8GB RAM, 32GB disk | `k3s`, `worker` |
| **`uranus`** (VM 506) | Agent (Worker Node) | `192.168.10.25` | 2 vCPU, 8GB RAM, 32GB disk | `k3s`, `worker` |
| **`neptune`** (VM 507) | Agent (Worker Node) | `192.168.10.26` | 2 vCPU, 8GB RAM, 32GB disk | `k3s`, `worker` |
| **`pluto`** (VM 508) | Agent (Worker Node) | `192.168.10.27` | 2 vCPU, 8GB RAM, 32GB disk | `k3s`, `worker` |

## Storage & Networking Defaults

- **Storage**: Default `local-path` StorageClass (`rancher.io/local-path`) backed by VM local disk storage for `PersistentVolumeClaims`.
- **Networking**: Flannel CNI (`vxlan`), CoreDNS internal service resolution.
- **Lightweight Profile**: Traefik and ServiceLB are disabled in favor of minimal overhead, allowing explicit NodePort or lightweight Ingress controllers.

## Directory Structure

```text
kubernetes/
├── shared/
│   └── values/               # Shared Helm values overrides
│       ├── metallb.yaml      # Controller & speaker configuration
│       └── traefik.yaml      # Traefik LoadBalancer service & entrypoints
├── main/                     # Main 10-node cluster (mercury...pluto + raspi)
│   ├── helmfile.yaml         # MetalLB + Traefik releases
│   └── manifests/
│       ├── metallb-pool.yaml # lan-pool: 192.168.10.200 - 192.168.10.220
│       └── uptime-kuma.yaml  # Deployment, PVC, Service, and Ingress (kuma.lan)
├── minecraft/                # Standalone 1-node cluster (minecraft @ 192.168.10.76)
│   ├── helmfile.yaml         # MetalLB + Traefik releases
│   └── manifests/
│       └── metallb-pool.yaml # minecraft-pool: 192.168.10.77 - 192.168.10.81
└── images/                   # Dockerfiles & build contexts for custom cluster images
```

## Ingress & Load Balancing Architecture

Both clusters share identical ingress architecture while remaining completely isolated:

1. **MetalLB (v0.16.2)**:
   - Deployed via Helmfile into `metallb-system`.
   - Runs `metallb-controller` and `metallb-speaker` daemon.
   - **`main` pool**: `192.168.10.200 - 192.168.10.220` with Layer 2 ARP advertisements (`l2-adv`).
   - **`minecraft` pool**: `192.168.10.77 - 192.168.10.81` with Layer 2 ARP advertisements (`minecraft-l2-adv`).
2. **Traefik (v42.3.2 / App v3.7.17)**:
   - Deployed via Helmfile into `traefik`.
   - Exposed as `type: LoadBalancer`. On `main` it acquires `192.168.10.200`; on `minecraft` it acquires `192.168.10.77`.
   - On `minecraft`, using VIP `.77` avoids port collisions with the host Docker CTFd container on `192.168.10.76:80`.

> [!IMPORTANT]
> **DPI Note on Quay.io & Akamai CDN**:
> MetalLB container images (`quay.io/metallb/controller`, `quay.io/metallb/speaker`) download layer blobs from Akamai CDN (`cdn01.quay.io` on `23.0.0.0/8`). Akamai drops TCP segments carrying the TCP Urgent (`URG`) pointer flag used by OOB DPI circumvention (`zapret2` and `byedpi`).
> Ensure `23.0.0.0/8`, `quay.io`, and `cdn01.quay.io` are bypassed on the gateway router (`192.168.10.254`) and workstations; otherwise image pulls will hang with `net/http: TLS handshake timeout`.
> Furthermore, `metallb-pool.yaml` relies on `metallb-webhook-service`. The controller pod must be fully pulled and running before applying pool CRDs.

## Quick Start & Operator Workflow

The root [`Justfile`](file:///home/trueking/Safe/Proj/infra/Justfile) provides the unified operator interface:

### 1. Cluster Inspection

```bash
# Main cluster nodes & pods
just k get nodes -o wide
just k get pods -A

# Minecraft cluster nodes & pods
just k-mc get nodes -o wide
just k-mc get pods -A
```

### 2. Deploy Ingress Infrastructure (Helmfile & Manifests)

```bash
# Preview helm diff (default: main)
just k-diff
just k-diff minecraft

# Full declarative sync (Helmfile releases + wait for webhook + apply manifests)
just k-sync               # Syncs main cluster
just k-sync minecraft     # Syncs minecraft cluster (alias: just k-mc-sync)
```

### 3. Deploy Custom Manifests

```bash
# Apply all manifests for a cluster
just k-apply              # Applies kubernetes/main/manifests
just k-apply minecraft    # Applies kubernetes/minecraft/manifests
```

### 4. Direct Kubectl Commands

```bash
# Main cluster
just k logs -n <namespace> <pod-name> -f
just k describe node mercury

# Minecraft cluster
just k-mc logs -n <namespace> <pod-name> -f
just k-mc get svc -n traefik
```
