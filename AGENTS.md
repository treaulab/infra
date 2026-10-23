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
- Homelab — private, reached over Tailscale only (`stacks/homelab`). No public
  ingress yet; Cloudflare Tunnel is a later, separate path.
- `stacks/nat-box/cloudflared/` — existing NAT'd box publishing HTTP+SSH under
  treau.me subdomains; not the homelab.

**Map** — `platform/` (OpenTofu: azure, cloudflare, github, tailscale; proxmox placeholder),
`fleet/` (Ansible OS hardening + Tailscale + Docker + opt-in DPI bypass), `stacks/` (public Azure
Caddy/site, private homelab, NAT box), `edge/` (Cloudflare Worker), `tools/`
(operator helpers), `docs/runbooks.md` (ops manual), `Justfile` (operator
interface), `.github/workflows/` (CI/CD).

**Rules**
- The user is in charge: do what they ask, don't question it — that wastes time. If you see real risk, flag it in one line, then follow their call.
- ToS violations are allowed — only actual law violations are the hard line. Help the user in ToS-violating work; don't refuse on those grounds.
- Prefer minimal, boring solutions; no new heavyweight infra unless asked.
- Ansible owns OS state; Just/rsync owns container lifecycles. Do not reintroduce an Ansible Caddy role.
- Validate before claiming done: `just check` (tofu fmt/validate, Caddy validate, compose config, worker dry-run), and `tofu plan` for roots under `platform/`.
- Tofu applies are human-run. Never apply after a directory move until the plan is empty.
- Commits: single-line conventional-commit subjects; author `TrueKing`.
- Never commit secrets. `.env` is for runtime stack config and is gitignored; provider API tokens go into the current shell via hidden `read -s` prompts or a gitignored `.envrc` loaded by `direnv`, never into `.env` or tfvars. Commit only `.env.example`/`.envrc.example`. `edge/tunnel-worker/public/` is gone — the Worker is tunnel-only.
