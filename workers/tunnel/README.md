# treaulab-tunnel (Cloudflare Worker — tunnels on go.treau.me)

HTTP tunnels + SSH pipes for agents behind NAT / locked-down origins, served
on `go.treau.me`. The tunnel/pipe code never `fetch()`es an origin — the VPS
is not in the tunnel data path.

The main site (`treau.me`) is served by the Azure VPS (Caddy). This Worker
carries a synced copy of the site only for dev/preview hosts (`workers.dev`).
Moving the apex onto the Worker is an optional, unexecuted migration (see the
cutover section below).

## What lives here

```
workers/tunnel/
├── wrangler.toml      # Worker + Static Assets + Durable Object bindings/migrations
├── src/worker.js      # routing: www→apex, /health, /t/*, /p/*, assets+404
├── src/tunnel.js      # TunnelRoom DO: HTTP reverse tunnel over agent socket
├── src/pipe.js        # PipeRoom DO: multiplexed raw-TCP pipe (ssh), one room/box
├── lib/shared.js      # shared protocol: IDs, hop headers, backoff, v2 streaming, pipe frames
├── agent/agent.js     # zero-dep dial-out agent for locked-down HTTP origins
├── agent/tcp-agent.js # zero-dep dial-out agent: per-stream TCP dial to :22
├── agent/agent.py     # stdlib-only Python twin of agent.js (same protocol)
├── bin/tunnel         # CLI (share/add/up/info/ssh/list/rm/doctor)
├── bin/ws-ssh-proxy.js# zero-dep laptop stdio helper (ssh ProxyCommand)
├── TUNNEL.md          # HTTP tunnel protocol + ops (worse-cloudflared)
├── PIPE.md            # SSH pipe protocol + ops (ProxyCommand UX)
├── public/            # GENERATED (gitignored) from apps/website/src via sync:public
├── .dev.vars.example  # local-dev secret template (real values never committed)
└── package.json       # sync/dev/deploy scripts
```

Single source for the site stays `apps/website/src/` — `public/` is a build
artifact synced by `npm run sync:public`, never edited by hand.

## Use it (`tunnel` CLI)

```bash
cd workers/tunnel && npm install          # exposes `tunnel` via npm run tunnel --
npm run tunnel -- share http://127.0.0.1:8080   # zero setup: host defaults to go.treau.me
npm run tunnel -- add site1 http://127.0.0.1:8080
npm run tunnel -- add lockedvps 127.0.0.1:22
npm run tunnel -- info site1            # public URL + live check
npm run tunnel -- up lockedvps          # on the origin box (foreground)
npm run tunnel -- ssh lockedvps         # from the laptop
```

Instant share needs no saving and no setup — `share` alone is enough
(defaults to `http://127.0.0.1:8080`); add `--name tmp` to remember it,
`--json` for scripts:

```bash
npm run tunnel -- share [TARGET] [--name tmp] [--json]
```

Host defaults to `https://go.treau.me` (override with `--host H` or
`TUNNEL_HOST=https://...`).

No Node on the origin box? The agent has a pure-stdlib Python twin —
no pip, no clone needed (see `agent/README.md`):

```bash
curl -fsSL https://raw.githubusercontent.com/treaulab/infra/main/workers/tunnel/agent/agent.py -o /tmp/agent.py
python3 /tmp/agent.py http://127.0.0.1:8080
```

Prefer a bare `tunnel` on PATH? `npm link` (or keep the manual
`ln -sf "$PWD/bin/tunnel" ~/.local/bin/tunnel`), then drop the
`npm run tunnel --` prefix. Per-command help: `tunnel <command> --help`.

State lives in `~/.config/treaulab/tunnels.json` (named tunnels + ids).

Full command reference: `tunnel help`. Protocol details (no-CLI fallback):
`TUNNEL.md` / `PIPE.md`.

## Local dev

```bash
cd workers/tunnel
npm install
npm run dev                      # http://127.0.0.1:8787 (no secrets needed)
# static:  curl -sI http://127.0.0.1:8787/
```

Generate a room ID: `openssl rand -hex 16` (32 chars, meets 20-64 rule).

## Secrets / first deploy (none)

```bash
cd workers/tunnel
npx wrangler login
npm run deploy                        # → https://treaulab-tunnel.<acct>.workers.dev
```

Long-URL-only: no `wrangler secret put` needed. If you previously set
`RELAY_TOKEN` / `PIPE_TOKEN`, delete them once:
`npx wrangler secret delete RELAY_TOKEN` + `PIPE_TOKEN`.

CI: `ci.yml` runs on project PRs (path-filtered to `workers/tunnel/**` +
`apps/website/src/**`) — syntax checks, `npm run deploy:dry`, and a live
`share` round-trip against `wrangler dev`; no secrets needed. On main pushes
`tunnel.yml` runs that same CI first, then deploys (skipped with a notice when
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets are unset —
then deploy manually with `npm run deploy`).
SSH-pipe usage: `PIPE.md` (`tunnel ssh lockedvps`).

Dry-run validation without uploading: `npm run deploy:dry`.

## One-time cutover: treaulab-edge → treaulab-tunnel

Cloudflare does not rename a deployed Worker, so the **first deploy under the
new name creates `treaulab-tunnel`** while `go.treau.me` keeps being served by
the old `treaulab-edge` until you move it (the old Worker is the rollback
until then):

1. `npm run deploy` (or let `tunnel.yml` deploy once the CF secrets are set)
   — creates `treaulab-tunnel`.
2. Dashboard → Workers & Pages → `treaulab-edge` → Settings → Domains &
   Routes → remove the `go.treau.me` custom domain (or edit the route).
3. Dashboard → `treaulab-tunnel` → Settings → Domains & Routes → add custom
   domain `go.treau.me` — do this right after step 2; tunnels pause for the
   short gap between the two.
4. Verify: `curl -s https://go.treau.me/health` → `ok`, one `tunnel share`
   round-trip, then delete `treaulab-edge` (Settings → Delete) once happy.

## Optional — apex cutover onto the Worker (NOT the current state)

Current state: `treau.me`/`www` are served by the Azure VPS behind the
Cloudflare proxy; the Worker serves `go.treau.me` only. If you ever move the
apex onto the Worker:

1. Dashboard → Workers → `treaulab-tunnel` → Custom Domains → add `treau.me`
   (+ `www.treau.me`; the Worker itself 301s www→apex).
2. Verify on the custom domain before touching anything else:
   `curl -sI https://treau.me/` → `200`, `/robots.txt`, `/sitemap.xml`,
   `/.well-known/security.txt`, `/nope-123` → `404` + `noindex`.
3. The VPS is then out of the site path (verify: `docker logs caddy` shows no
   new access). Keep it warm 48h as the rollback.
4. Only after the soak, optionally stop Caddy / close NSG `80/443` /
   deallocate the VM. Rollback anytime = repoint DNS to the VPS record
   (no code change).

## Notes / limits

* Hibernation: idle rooms sleep (no duration billing), wake on message.
  Deploys **drop all connections** — clients must reconnect with backoff.
* Plan caps: free ≈100k req/day, 10ms CPU, 5GB DO storage; real use wants
  Paid. 32 MiB runtime inbound cap; app enforces 1 MiB.
* Abuse: long-URL obscurity is the only gate — anyone with the link can use
  it. Rotate by creating a fresh ID (`tunnel create` / `--url`) and dropping
  the old one. Short IDs → `404`.
* ToS: private tunnel/pipe use is fine; don't repurpose as a circumvention VPN
  without checking Workers/Zero Trust terms — sanctioned private access is
  Tunnel + Access/WARP instead.
