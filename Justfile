# Operator entry point. Run `just --list`.
set shell := ["bash", "-uc"]

_default:
    @just --list

# Display fleet inventory hierarchy and capability tiers.
matrix:
    #!/usr/bin/env bash
    set -euo pipefail
    cd fleet
    echo "=== Inventory Hierarchy ==="
    ansible-inventory -i inventory/prod.yml --graph
    echo ""
    echo "=== Fleet Capability Matrix ==="
    printf "%-18s %-6s %-9s %-9s %-8s %-10s %-12s\n" "Host" "UFW" "Fail2ban" "SSH-Hard" "Docker" "ByeDPI" "K3s"
    printf "%-18s %-6s %-9s %-9s %-8s %-10s %-12s\n" "------------------" "------" "---------" "---------" "--------" "----------" "------------"
    for host in $(ansible all -i inventory/prod.yml --list-hosts 2>/dev/null | tail -n +2 | tr -d ' '); do
      vars=$(ansible-inventory -i inventory/prod.yml --host "$host" 2>/dev/null)
      ufw=$(echo "$vars" | jq -r 'if .enable_ufw == true then "ON" else "OFF" end')
      f2b=$(echo "$vars" | jq -r 'if .enable_fail2ban == true then "ON" else "OFF" end')
      ssh_h=$(echo "$vars" | jq -r 'if .enable_ssh_hardening == true then "ON" else "OFF" end')
      byedpi=$(echo "$vars" | jq -r 'if .enable_byedpi == true then "ON" else "OFF" end')
      k3s=$(echo "$vars" | jq -r 'if .enable_k3s == true then (.k3s_role // "ON") else "OFF" end')
      printf "%-18s %-6s %-9s %-9s %-8s %-10s %-12s\n" "$host" "$ufw" "$f2b" "$ssh_h" "ON" "$byedpi" "$k3s"
    done

# Install/verify local tooling and Ansible collections.
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    for c in git just tofu ssh rsync docker direnv; do
      command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 1; }
    done
    command -v ansible-playbook >/dev/null || { echo "missing: ansible-playbook (NixOS: nix-shell -p ansible)" >&2; exit 1; }
    if command -v pre-commit >/dev/null 2>&1; then
      pre-commit install
    fi
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
      (cd compose/public/caddy && docker compose config >/dev/null)
    elif command -v docker-compose >/dev/null 2>&1; then
      (cd compose/public/caddy && docker-compose config >/dev/null)
    else
      echo "ERROR: docker compose plugin (or docker-compose) is required" >&2
      exit 1
    fi
    caddy_env=compose/public/caddy/.env
    [[ -f "$caddy_env" ]] || caddy_env=compose/public/caddy/.env.example
    docker run --rm --network none --entrypoint caddy \
      --env-file "$caddy_env" \
      -v "$PWD/compose/public/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
      docker.io/library/caddy:2.11 validate --config /etc/caddy/Caddyfile
    echo "== worker dry-run"
    (cd edge/tunnel-worker && npm run deploy:dry)
    git diff --check
    echo "OK"

# Full fleet convergence: OS baseline → compose stacks → k3s (site.yml).
# Scope to a single host or group with node=<name>.
converge node="all":
    #!/usr/bin/env bash
    set -euo pipefail
    target="{{node}}"
    target="${target#node=}"
    cd fleet
    ansible-playbook -i inventory/prod.yml playbooks/site.yml --limit "$target"
    cd ..
    mkdir -p .kube
    for kf in ".kube/k3s-$target.yaml" ".kube/k3s.yaml"; do
      if [ -f "$kf" ]; then
        host_ip=$(cd fleet && ansible-inventory -i inventory/prod.yml --host "mercury" 2>/dev/null | jq -r '.ansible_host // empty')
        if [ -n "$host_ip" ]; then
          sed -i "s/127.0.0.1/$host_ip/g" "$kf"
        fi
        echo "Kubeconfig ready: KUBECONFIG=$kf kubectl get nodes"
      fi
    done

# Converge K3s cluster nodes (runs host.yml scoped to cluster group).
k3s node="cluster":
    #!/usr/bin/env bash
    set -euo pipefail
    target="{{node}}"
    target="${target#node=}"
    cd fleet
    ansible-playbook -i inventory/prod.yml playbooks/host.yml --limit "$target"
    cd ..
    mkdir -p .kube
    for kf in ".kube/k3s-$target.yaml" ".kube/k3s.yaml"; do
      if [ -f "$kf" ]; then
        host_ip=$(cd fleet && ansible-inventory -i inventory/prod.yml --host "mercury" 2>/dev/null | jq -r '.ansible_host // empty')
        if [ -n "$host_ip" ]; then
          sed -i "s/127.0.0.1/$host_ip/g" "$kf"
        fi
        echo "Kubeconfig ready: KUBECONFIG=$kf kubectl get nodes"
      fi
    done

# Ping hosts across any inventory group (default: untrusted).
ping group="untrusted":
    cd fleet && ansible "{{group}}" -i inventory/prod.yml -m ping -e ansible_become=false

# Converge untrusted compute workstations (Docker, packages, Tailscale; UFW disabled).
untrusted *args="":
    cd fleet && ansible-playbook -i inventory/prod.yml playbooks/host.yml --limit untrusted {{args}}

# Converge only UFW firewall rules on one host (or trusted fleet).
ufw node="trusted":
    cd fleet && ansible-playbook -i inventory/prod.yml playbooks/host.yml --limit "{{node}}" --tags firewall

# Converge only Tailscale on one host (or trusted fleet).
ts node="trusted":
    cd fleet && ansible-playbook -i inventory/prod.yml playbooks/host.yml --limit "{{node}}" --tags tailscale

# Converge ByeDPI transparent & SOCKS5 proxy on a host (default: untrusted).
byedpi node="untrusted":
    cd fleet && ansible-playbook -i inventory/prod.yml playbooks/host.yml --limit "{{node}}" --tags byedpi

# Run kubectl against the homelab cluster.
k *args:
    #!/usr/bin/env bash
    set -euo pipefail
    cfg=""
    for candidate in .kube/k3s.yaml .kube/k3s-mercury.yaml .kube/k3s-venus.yaml .kube/k3s-*.yaml; do
      if [ -f "$candidate" ]; then
        cfg="$candidate"
        break
      fi
    done
    if [ -z "$cfg" ]; then
      echo "ERROR: no kubeconfig found in .kube/. Run 'just converge mercury' first." >&2
      exit 1
    fi
    KUBECONFIG="$cfg" kubectl {{args}}

# Apply manifests from kubernetes/manifests.
k-apply path="kubernetes/manifests":
    @just k apply -f {{path}}

# Deploy Caddy + static website to the Azure VPS.
deploy-public env="prod":
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p logs
    cd fleet
    ANSIBLE_LOG_PATH="../logs/deploy-public-{{env}}-$(date +%Y%m%d-%H%M%S).log" \
      ansible-playbook -i "inventory/{{env}}.yml" playbooks/compose.yml --limit edge

# Deploy Docker Compose stack(s) to a host under /opt/stacks/<stack>.
# Runs inventory-declared compose_stacks for the host by default.
# Pass stack= and src= for an ad-hoc one-off deployment.
deploy-compose host stack="" src="":
    #!/usr/bin/env bash
    set -euo pipefail
    extra=""
    [[ -n "{{stack}}" ]] && extra="$extra -e adhoc_stack_name={{stack}}"
    [[ -n "{{src}}" ]]   && extra="$extra -e adhoc_stack_src={{src}}"
    cd fleet && ansible-playbook -i inventory/prod.yml playbooks/compose.yml \
      -e "target={{host}}" $extra

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
    git check-ignore -q compose/public/caddy/.env
    if [ -e .envrc ]; then
      git check-ignore -q .envrc
    fi
    echo "OK: secrets paths are ignored and no .env/.envrc is tracked."
