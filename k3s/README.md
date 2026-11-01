# k3s

Declarative Kubernetes state for the homelab cluster.

## Structure

- `manifests/` — Declarative Kubernetes manifests for cluster workloads.
- `images/` — Container image source definitions for custom cluster containers.
- Host convergence and the K3s engine lifecycle are managed via Ansible at `fleet/playbooks/host.yml` (`enable_k3s: true`).

## Quick Start

1. Install/converge K3s on both nodes (`mercury` server, `venus` agent):
   ```bash
   just converge mercury
   just converge venus
   ```

2. Run `kubectl` commands against the cluster over Tailscale:
   ```bash
   just k get nodes
   just k get pods -A
   ```

3. Apply manifests:
   ```bash
   just k-apply k3s/manifests
   ```
