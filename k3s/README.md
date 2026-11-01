# k3s

Declarative Kubernetes state for the homelab cluster.

## Structure

- `manifests/` — Raw Kubernetes manifests, Kustomizations, or Helm definitions applied to the cluster.
- Host convergence and the K3s engine lifecycle are managed via Ansible at `fleet/playbooks/k3s.yml`.

## Quick Start

1. Install/converge K3s on the target node (`node-01` by default):
   ```bash
   just k3s node=node-01
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
