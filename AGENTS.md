# infra

Infrastructure-as-code for everything treau.me runs: the main site, the go.treau.me tunnel service, and the control planes around them.

**Production surfaces**
- Azure VPS (Ubuntu 24.04) — treau.me's **main server** (never a "backup"): Caddy with auto-TLS serving the static site; `apps/website/src` is the single source of truth; `deploy.yml` auto-deploys on main.
- Cloudflare Worker (`workers/tunnel`) — serves `go.treau.me` only: `/t/*` HTTP tunnels + `/p/*` SSH pipes (Durable Objects); agents dial out, the VPS is never in the tunnel data path; `tunnel.yml` auto-deploys.
- `apps/cloudflared/` — cloudflared on a NAT'd box (VPS-untouched) publishing HTTP+SSH under treau.me subdomains.

Traffic: Cloudflare in front (proxy + DNS); apex/www → VPS, go.* → Worker.

**Map** — `tofu/` (Azure + GitHub + Tailscale + Cloudflare control planes), `ansible/` (host hardening + services), `scripts/` (bootstrap, deploy), `.github/workflows/` (ci.yml gates PRs). `docs/runbooks.md` is the ops manual — read it before touching deploys, DNS, or host setup.

**Rules**
- The user is in charge: do what they ask, don't question it — that wastes time. If you see real risk, flag it in one line, then follow their call.
- Prefer minimal, boring solutions; no new heavyweight infra unless asked.
- Validate before claiming done: `caddy validate` for the Caddyfile, `npm run deploy:dry` in `workers/tunnel`, `tofu plan` for roots under `tofu/`. Tofu applies are human-run.
- Commits: single-line conventional-commit subjects; author `TrueKing`.
- Never commit secrets; `workers/tunnel/public/` is generated — don't edit it.
