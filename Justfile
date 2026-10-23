# Operator entry point. Run `just --list`.
set shell := ["bash", "-uc"]

_default:
    @just --list

# Install/verify local tooling and Ansible collections.
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    for c in git just tofu ssh rsync docker; do
      command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 1; }
    done
    command -v ansible-playbook >/dev/null || { echo "missing: ansible-playbook (NixOS: nix-shell -p ansible)" >&2; exit 1; }
    ansible-galaxy collection install -r fleet/requirements.yml
    echo "OK. Next: cp platform/azure/envs/prod.tfvars.example platform/azure/envs/prod.tfvars"
    echo "            cp fleet/inventory/prod.yml.example fleet/inventory/prod.yml"

# Plan one OpenTofu root: azure, cloudflare, github, or tailscale.
plan root="azure":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{root}}" in
      azure)
        cd platform/azure
        tofu init
        tofu plan -var-file=envs/prod.tfvars
        ;;
      cloudflare|github|tailscale)
        cd "platform/{{root}}"
        tofu init
        tofu plan
        ;;
      *)
        echo "unknown root: {{root}} (use azure|cloudflare|github|tailscale)" >&2
        exit 2
        ;;
    esac

# Plan every OpenTofu root in sequence.
plan-all:
    #!/usr/bin/env bash
    set -euo pipefail
    for r in azure cloudflare github tailscale; do
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
    for r in azure cloudflare github tailscale; do
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

# Converge OS + Tailscale + Docker on one inventory host (or all with `all`).
converge node="all":
    cd fleet && ansible-playbook -i inventory/prod.yml playbooks/site.yml --limit "{{node}}"

# OS baseline only: hardening + Tailscale.
bootstrap node="all":
    cd fleet && ansible-playbook -i inventory/prod.yml playbooks/bootstrap.yml --limit "{{node}}"

# Docker engine only.
docker node="all":
    cd fleet && ansible-playbook -i inventory/prod.yml playbooks/docker.yml --limit "{{node}}"

# Deploy Caddy + static website to the Azure VPS.
deploy-public env="prod":
    tools/deploy-public.sh "{{env}}"

# Backwards-compatible alias for deploy-public.
deploy-edge env="prod":
    @just deploy-public "{{env}}"

# Deploy one private homelab stack over Tailscale.
deploy-home app env="prod":
    tools/deploy-home.sh "{{app}}" "{{env}}"

# Pin a tailnet-runner spoke to a hub SHA.
bump-spoke repo sha:
    tools/bump-spoke.sh "{{repo}}" "{{sha}}"

# Dispatch a tailnet runner and SSH in.
gh-shell tenant="t1":
    tools/gh-shell.sh "{{tenant}}"

# Guard against accidentally tracking a plaintext .env.
secrets-check:
    #!/usr/bin/env bash
    set -euo pipefail
    if git ls-files | grep -E '(^|/)\.env$'; then
      echo "ERROR: a plaintext .env is tracked; remove it from git." >&2
      exit 1
    fi
    git check-ignore -q fleet/inventory/prod.yml
    git check-ignore -q stacks/public/caddy/.env
    echo "OK: secrets paths are ignored and no .env is tracked."
