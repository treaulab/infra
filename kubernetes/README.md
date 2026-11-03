# kubernetes

Declarative Kubernetes state for the homelab cluster.

## Structure

- `manifests/` — Declarative Kubernetes manifests for cluster workloads.
- `images/` — Container image source definitions for custom cluster containers.
- Host OS baseline is managed via `fleet/playbooks/host.yml`; K3s engine lifecycle is managed via `fleet/playbooks/k3s.yml` (`just k3s`).

## Quick Start

1. Install/converge K3s on the cluster (`mercury` server, `venus` and `earth` agents):
   ```bash
   just k3s
   ```

2. Run `kubectl` commands against the cluster over Tailscale:
   ```bash
   just k get nodes
   just k get pods -A
   ```

3. Apply manifests:
   ```bash
   just k-apply kubernetes/manifests
   ```
