# k3s

Declarative Kubernetes state for the homelab cluster.

## Structure

- `manifests/` — Declarative Kubernetes manifests (e.g. `zapret2.yaml` for DPI circumvention).
- `images/` — Container image source definitions (e.g. `images/zapret2/` built and pushed to GHCR by `.github/workflows/zapret2-image.yml`).
- Host convergence and the K3s engine lifecycle are managed via Ansible at `fleet/playbooks/host.yml` (`enable_k3s: true`).

## Quick Start

1. Install/converge K3s on the target node (`venus` by default):
   ```bash
   just k3s node=venus
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
