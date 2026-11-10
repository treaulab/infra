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
├── helmfile.yaml         # Helmfile orchestrating MetalLB and Traefik releases
├── values/               # Helm values overrides
│   ├── metallb.yaml      # Controller & speaker configuration
│   └── traefik.yaml      # Traefik LoadBalancer service & entrypoints
├── manifests/            # Declarative Kubernetes manifests (.yaml)
│   ├── metallb-pool.yaml # IPAddressPool (192.168.10.200-220) & L2Advertisement
│   └── uptime-kuma.yaml  # Deployment, PVC, Service, and Ingress (kuma.lan)
└── images/               # Dockerfiles & build contexts for custom cluster images
```

## Ingress & Load Balancing Architecture

The cluster runs a standard bare-metal ingress layer:

1. **MetalLB (v0.16.2)**:
   - Deployed via Helmfile into `metallb-system`.
   - Runs `metallb-controller` and `metallb-speaker` DaemonSet across all nodes.
   - Configured with `lan-pool`: `192.168.10.200 - 192.168.10.220` (unassigned high subnet block) with Layer 2 ARP advertisements (`l2-adv`).
2. **Traefik (v42.3.2 / App v3.7.17)**:
   - Deployed via Helmfile into `traefik`.
   - Exposed as `type: LoadBalancer`, acquiring the first VIP (`192.168.10.200`).
   - Ingress controller routes traffic by hostname (`Host: kuma.lan`) to backend services.

> [!IMPORTANT]
> **DPI Note on Quay.io & Akamai CDN**:
> MetalLB container images (`quay.io/metallb/controller`, `quay.io/metallb/speaker`) download layer blobs from Akamai CDN (`cdn01.quay.io` on `23.0.0.0/8`). Akamai drops TCP segments carrying the TCP Urgent (`URG`) pointer flag used by OOB DPI circumvention (`zapret2` and `byedpi`).
> Ensure `23.0.0.0/8`, `quay.io`, and `cdn01.quay.io` are bypassed on the gateway router (`192.168.10.254`) and workstations; otherwise image pulls will hang with `net/http: TLS handshake timeout`.
> Furthermore, `metallb-pool.yaml` relies on `metallb-webhook-service`. The controller pod must be fully pulled and running before applying pool CRDs.

## Quick Start & Operator Workflow

The root [`Justfile`](file:///home/trueking/Safe/Proj/infra/Justfile) provides the operator interface:

### 1. Converge K3s Engine & Fetch Kubeconfig

Deploy or update the K3s cluster across all nodes:
```bash
just k3s
```
*This installs/updates K3s, configures `mercury` as server, connects agent nodes, and automatically fetches and configures your local kubeconfig at `.kube/k3s.yaml`.*

### 2. Deploy Ingress Infrastructure (Helmfile)

Deploy MetalLB and Traefik:
```bash
# Preview helm diff
just k-diff
# Sync releases
just k-sync
# Or direct helmfile:
helmfile --file kubernetes/helmfile.yaml apply
```

Apply MetalLB IP address pool and L2 advertisement:
```bash
just k-apply path="kubernetes/manifests/metallb-pool.yaml"
```

### 3. Inspect Cluster Health

```bash
just k get nodes -o wide
just k get pods -A
just k get svc -n traefik
```

### 4. Deploy Workloads

Apply any manifest or directory under `kubernetes/manifests/`:
```bash
just k-apply path="kubernetes/manifests"
# or apply a specific manifest:
just k-apply path="kubernetes/manifests/uptime-kuma.yaml"
```

### 4. Direct Kubectl Commands

The `just k` helper automatically binds to `.kube/k3s.yaml`:
```bash
just k logs -n <namespace> <pod-name> -f
just k describe node mercury
just k port-forward -n <namespace> svc/<service-name> 8080:80
```
