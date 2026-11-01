# Operator entry point. Run `just --list`.
set shell := ["bash", "-uc"]

_default:
    @just --list

# Install/verify local tooling and Ansible collections.
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    for c in git just tofu ssh rsync docker direnv; do
      command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 1; }
    done
    command -v ansible-playbook >/dev/null || { echo "missing: ansible-playbook (NixOS: nix-shell -p ansible)" >&2; exit 1; }
    echo "OK. Next: cp fleet/inventory/prod.yml.example fleet/inventory/prod.yml"
    echo "            cp .envrc.example .envrc && chmod 600 .envrc && direnv allow ."

# Lint fleet Ansible playbooks (requires ansible-lint).
fleet-check:
    cd fleet && ansible-lint playbooks

# Plan one OpenTofu root: azure, cloudflare, github, proxmox, or tailscale.
plan root="azure":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{root}}" in
      azure|cloudflare|github|tailscale|proxmox)
        cd "platform/{{root}}"
        tofu init
        tofu plan
        ;;
      *)
        echo "unknown root: {{root}} (use azure|cloudflare|github|proxmox|tailscale)" >&2
        exit 2
        ;;
    esac

# Plan every OpenTofu root in sequence.
plan-all:
    #!/usr/bin/env bash
    set -euo pipefail
    for r in azure cloudflare github tailscale proxmox; do
      echo "== plan $r"
      just plan "$r"
    done

# Format OpenTofu files.
fmt:
    tofu fmt -recursive platform

# Validate configs without touching any infrastructure.
check:
    #!/usr/bin/env bash
    set -euo pipefail
    tofu fmt -check -recursive platform
    for r in azure cloudflare github tailscale proxmox; do
      echo "== validate $r"
      (cd "platform/$r" && tofu init -backend=false >/dev/null && tofu validate)
    done
    echo "== caddy validate"
    if docker compose version >/dev/null 2>&1; then
      (cd stacks/public/caddy && docker compose config >/dev/null)
    elif command -v docker-compose >/dev/null 2>&1; then
      (cd stacks/public/caddy && docker-compose config >/dev/null)
    else
      echo "ERROR: docker compose plugin (or docker-compose) is required" >&2
      exit 1
    fi
    caddy_env=stacks/public/caddy/.env
    [[ -f "$caddy_env" ]] || caddy_env=stacks/public/caddy/.env.example
    docker run --rm --network none --entrypoint caddy \
      --env-file "$caddy_env" \
      -v "$PWD/stacks/public/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
      docker.io/library/caddy:2.11 validate --config /etc/caddy/Caddyfile
    echo "== worker dry-run"
    (cd edge/tunnel-worker && npm run deploy:dry)
    git diff --check
    echo "OK"

# Converge OS baseline (UFW + Tailscale + Docker) on one host (or all).
converge node="all":
    #!/usr/bin/env bash
    set -euo pipefail
    target="{{node}}"
    target="${target#node=}"
    cd fleet
    ansible-playbook -i inventory/prod.yml playbooks/host.yml --limit "$target"
    cd ..
    mkdir -p .kube
    kube_file=".kube/k3s-$target.yaml"
    if [ -f "$kube_file" ]; then
      host_ip=$(cd fleet && ansible-inventory -i inventory/prod.yml --host "$target" 2>/dev/null | jq -r '.ansible_host // empty')
      if [ -n "$host_ip" ]; then
        sed -i "s/127.0.0.1/$host_ip/g" "$kube_file"
      fi
      echo "Kubeconfig ready: KUBECONFIG=$kube_file kubectl get nodes"
    fi

# Backwards-compatible aliases for host convergence.
bootstrap node="all":
    @just converge "{{node}}"

docker node="all":
    @just converge "{{node}}"

# Alias for converging a K3s node (default: venus).
k3s node="venus":
    @just converge "{{node}}"

# Run kubectl against the homelab cluster.
k *args:
    #!/usr/bin/env bash
    set -euo pipefail
    cfg=""
    for candidate in .kube/k3s-venus.yaml .kube/k3s-node-01.yaml .kube/k3s-*.yaml; do
      if [ -f "$candidate" ]; then
        cfg="$candidate"
        break
      fi
    done
    if [ -z "$cfg" ]; then
      echo "ERROR: no kubeconfig found in .kube/. Run 'just k3s' first." >&2
      exit 1
    fi
    KUBECONFIG="$cfg" kubectl {{args}}

# Apply manifests from k3s/manifests.
k-apply path="k3s/manifests":
    @just k apply -f {{path}}

# Deploy Caddy + static website to the Azure VPS.
deploy-public env="prod":
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p logs
    cd fleet
    ANSIBLE_LOG_PATH="../logs/deploy-public-{{env}}-$(date +%Y%m%d-%H%M%S).log" \
      ansible-playbook -i "inventory/{{env}}.yml" playbooks/deploy.yml

# Backwards-compatible alias for deploy-public.
deploy-edge env="prod":
    @just deploy-public "{{env}}"

# Pin a tailnet-runner spoke to a hub SHA.
bump-spoke repo sha:
    tools/bump-spoke.sh "{{repo}}" "{{sha}}"

# Dispatch a tailnet runner and SSH in.
gh-shell tenant="t1":
    tools/gh-shell.sh "{{tenant}}"

# Guard against accidentally tracking plaintext local credentials.
secrets-check:
    #!/usr/bin/env bash
    set -euo pipefail
    if git ls-files | grep -E '(^|/)\.env(rc)?$'; then
      echo "ERROR: a plaintext .env/.envrc is tracked; remove it from git." >&2
      exit 1
    fi
    git check-ignore -q fleet/inventory/prod.yml
    git check-ignore -q stacks/public/caddy/.env
    if [ -e .envrc ]; then
      git check-ignore -q .envrc
    fi
    echo "OK: secrets paths are ignored and no .env/.envrc is tracked."
