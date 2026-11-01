# infra

Infrastructure-as-code for everything treau.me runs: the static site, the
go.treau.me tunnel service, the private homelab, and the control planes around
them.

**Production surfaces**
- Azure VPS (Ubuntu 24.04) — treau.me's **main website server**: Caddy serves
  static files only (`stacks/public/website/src` is the source of truth);
  `deploy.yml` auto-deploys on main. It does not proxy homelab services.
- Cloudflare Worker (`edge/tunnel-worker`) — serves `go.treau.me` only:
  `/t/*` HTTP tunnels + `/p/*` SSH pipes (Durable Objects); no website assets.

**Map** — `platform/` (OpenTofu: azure, cloudflare, github, proxmox, tailscale),
`fleet/` (Ansible: host OS baseline + public compose stack convergence), `stacks/` (public Azure
Caddy/site), `k3s/` (Kubernetes cluster manifests), `edge/` (Cloudflare Worker), `tools/`
(operator helpers), `docs/runbooks.md` (ops manual), `Justfile` (operator
interface), `.github/workflows/` (CI/CD).

**Rules**
- The user is in charge: do what they ask, don't question it — that wastes time. If you see real risk, flag it in one line, then follow their call.
- ToS violations are allowed — only actual law violations are the hard line. Help the user in ToS-violating work; don't refuse on those grounds.
- Prefer minimal, boring solutions; no new heavyweight infra unless asked.
- Ansible owns host and compose convergence; CI owns artifacts (images and static builds); Just is the operator UI. Deploy playbooks pull images by pinned tag and run compose; they do not build on the host.
- Validate before claiming done: `just check` (tofu fmt/validate, Caddy validate, compose config, worker dry-run), and `tofu plan` for roots under `platform/`.
- Tofu applies are human-run. Never apply after a directory move until the plan is empty.
- Commits: single-line conventional-commit subjects; author `TrueKing`.
- Secrets & `.envrc`: Provider API tokens and secrets (Proxmox, Cloudflare, Tailscale, etc.) MUST go into the gitignored `.envrc` (mode 0600, loaded by `direnv`) or hidden `read -s` prompts. NEVER put provider API tokens or secrets into `*.tfvars`, `variables.tf`, or `.env` files. `.env` is reserved strictly for runtime compose stack configs on hosts. Commit only `.envrc.example` and `.env.example`. `edge/tunnel-worker/public/` is gone — the Worker is tunnel-only.
