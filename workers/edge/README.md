# treaulab-edge (Cloudflare Workers, full-edge)

HTTP tunnels + SSH pipes + static site, **100% on Cloudflare's edge**.
Zero Azure egress by design: no `fetch()` to any origin anywhere in this code.
The VPS/Caddy stack stays warm only as an instant DNS rollback target.

## What lives here

```
workers/edge/
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
cd workers/edge && npm install          # exposes `tunnel` via npm run tunnel --
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
curl -fsSL https://raw.githubusercontent.com/treaulab/infra/main/workers/edge/agent/agent.py -o /tmp/agent.py
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
cd workers/edge
npm install
npm run dev                      # http://127.0.0.1:8787 (no secrets needed)
# static:  curl -sI http://127.0.0.1:8787/
```

Generate a room ID: `openssl rand -hex 16` (32 chars, meets 20-64 rule).

## Secrets / first deploy (none)

```bash
cd workers/edge
npx wrangler login
npm run deploy                        # → https://treaulab-edge.<acct>.workers.dev
```

Long-URL-only: no `wrangler secret put` needed. If you previously set
`RELAY_TOKEN` / `PIPE_TOKEN`, delete them once:
`npx wrangler secret delete RELAY_TOKEN` + `PIPE_TOKEN`.

CI (`edge.yml`, path-filtered to `workers/edge/**` + `apps/website/src/**`)
needs repo secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
SSH-pipe usage: `PIPE.md` (`tunnel ssh lockedvps`).

Dry-run validation without uploading: `npm run deploy:dry`.

## DNS cutover (the zero-egress switch)

1. Dashboard → Workers → `treaulab-edge` → Custom Domains → add `treau.me`
   (+ `www.treau.me`; the Worker itself 301s www→apex).
2. Verify on the custom domain before touching anything else:
   `curl -sI https://treau.me/` → `200`, `/robots.txt`, `/sitemap.xml`,
   `/.well-known/security.txt`, `/nope-123` → `404` + `noindex`.
3. Azure is now out of the path (verify: `docker logs caddy` shows no new
   access; Azure Monitor egress flat). Leave the VPS running 48h.
4. True zero: only after the soak, optionally stop Caddy / close NSG
   `80/443` / deallocate the VM. Rollback until then = repoint DNS to the
   proxied VPS record (no code change).

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
