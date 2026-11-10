# kubernetes

Declarative Kubernetes state and workload management for the homelab K3s cluster.

## Cluster Topology

Virtual machines are provisioned on the Proxmox VE hypervisor (`entia`) via OpenTofu (`platform/proxmox/`) and converged via Ansible (`fleet/roles/k3s`):

| Node | Role | IP Address | Specs | Tags |
| :--- | :--- | :--- | :--- | :--- |
| **`mercury`** (VM 500) | Server (Control Plane + Etcd/SQLite) | `192.168.10.11` | 2 vCPU, 4GB RAM, 32GB disk | `k3s`, `control-plane` |
| **`venus`** (VM 501) | Agent (Worker Node) | `192.168.10.13` | 2 vCPU, 4GB RAM, 32GB disk | `k3s`, `worker` |
| **`earth`** (VM 502) | Agent (Worker Node) | `192.168.10.14` | 2 vCPU, 4GB RAM, 32GB disk | `k3s`, `worker` |
| **`mars`** (VM 503) | Agent (Worker Node) | `192.168.10.22` | 2 vCPU, 4GB RAM, 32GB disk | `k3s`, `worker` |
| **`jupiter`** (VM 504) | Agent (Worker Node) | `192.168.10.23` | 2 vCPU, 4GB RAM, 32GB disk | `k3s`, `worker` |
| **`saturn`** (VM 505) | Agent (Worker Node) | `192.168.10.24` | 2 vCPU, 4GB RAM, 32GB disk | `k3s`, `worker` |
| **`uranus`** (VM 506) | Agent (Worker Node) | `192.168.10.25` | 2 vCPU, 4GB RAM, 32GB disk | `k3s`, `worker` |
| **`neptune`** (VM 507) | Agent (Worker Node) | `192.168.10.26` | 2 vCPU, 4GB RAM, 32GB disk | `k3s`, `worker` |
| **`pluto`** (VM 508) | Agent (Worker Node) | `192.168.10.27` | 2 vCPU, 4GB RAM, 32GB disk | `k3s`, `worker` |

## Storage & Networking Defaults

- **Storage**: Default `local-path` StorageClass (`rancher.io/local-path`) backed by VM local disk storage for `PersistentVolumeClaims`.
- **Networking**: Flannel CNI (`vxlan`), CoreDNS internal service resolution.
- **Lightweight Profile**: Traefik and ServiceLB are disabled in favor of minimal overhead, allowing explicit NodePort or lightweight Ingress controllers.

## Directory Structure

```text
kubernetes/
├── manifests/            # Declarative Kubernetes manifests (.yaml)
│   └── <service>.yaml    # Namespaces, Deployments, PVCs, Services
└── images/               # Dockerfiles & build contexts for custom cluster images
```

## Quick Start & Operator Workflow

The root [`Justfile`](file:///home/trueking/Safe/Proj/infra/Justfile) provides the operator interface:

### 1. Converge K3s Engine & Fetch Kubeconfig

Deploy or update the K3s cluster across all nodes:
```bash
just k3s
```
*This installs/updates K3s, configures `mercury` as server, connects `venus` and `earth` as agents, and automatically fetches and configures your local kubeconfig at `.kube/k3s.yaml`.*

### 2. Inspect Cluster Health

```bash
just k get nodes -o wide
just k get pods -A
```

### 3. Deploy Workloads

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
