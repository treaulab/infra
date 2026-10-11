# treaulab-edge (Cloudflare Workers, full-edge)

Client↔client WebSocket relay + static site, **100% on Cloudflare's edge**.
Zero Azure egress by design: no `fetch()` to any origin anywhere in this code.
The VPS/Caddy stack stays warm only as an instant DNS rollback target.

## What lives here

```
workers/edge/
├── wrangler.toml      # Worker + Static Assets + Durable Object bindings/migrations
├── src/worker.js      # routing: www→apex, /health, /ws/*, /t/*, /p/*, assets+404
├── src/room.js        # RelayRoom DO: hibernating broadcast relay, heartbeat, caps
├── src/tunnel.js      # TunnelRoom DO: HTTP reverse tunnel over agent socket
├── src/pipe.js        # PipeRoom DO: multiplexed raw-TCP pipe (ssh), one room/box
├── agent/agent.js     # zero-dep dial-out agent for locked-down HTTP origins
├── agent/tcp-agent.js # zero-dep dial-out agent: per-stream TCP dial to :22
├── bin/ws-ssh-proxy.js# zero-dep laptop stdio helper (ssh ProxyCommand)
├── TUNNEL.md          # HTTP tunnel protocol + ops (worse-cloudflared)
├── PIPE.md            # SSH pipe protocol + ops (ProxyCommand UX)
├── public/            # GENERATED (gitignored) from apps/website/src via sync:public
├── .dev.vars.example  # local-dev secret template (real values never committed)
└── package.json       # sync/dev/deploy scripts
```

Single source for the site stays `apps/website/src/` — `public/` is a build
artifact synced by `npm run sync:public`, never edited by hand.

## Protocol (long-URL-only, trycloudflare-style)

* Connect: `wss://<host>/ws/<roomId>` (`roomId` = `[A-Za-z0-9_-]{20,64}`,
  e.g. 32 hex chars). Anything sent is broadcast raw to every
  *other* socket in the same room. No persistence, no history.
  The long ID *is* the secret — no token. Short IDs → `404`.
* Heartbeat (doesn't wake a hibernated room): send exactly
  `__treaulab_ping__`, expect `__treaulab_pong__`.
* Non-websocket GET on a `/ws/` path → `426`.
* Soft caps (`src/room.js`): 1000 sockets/room, 1 MiB/message (close `1009`).

## Use it (`tunnel` CLI — mirrors `cloudflared tunnel`)

```bash
cd workers/edge && npm install          # exposes `tunnel` via npm run tunnel --
npm run tunnel -- --url http://127.0.0.1:8080   # zero setup: host defaults to go.treau.me
npm run tunnel -- create site1 --http --upstream http://127.0.0.1:8080
npm run tunnel -- create lockedvps --tcp --to 127.0.0.1:22
npm run tunnel -- route site1           # public URL (like: cloudflared tunnel route dns)
npm run tunnel -- run lockedvps         # on the origin box (like: tunnel run)
npm run tunnel -- access ssh lockedvps  # from the laptop (like: cloudflared access ssh)
```

Instant share needs no saving and no setup (trycloudflare-style) —
`--url` alone is enough; add `--name tmp` to remember it, `--output json`
for scripts:

```bash
npm run tunnel -- --url http://127.0.0.1:8080 [--name tmp] [--output json]
```

Host defaults to `https://go.treau.me` (override per-box with
`TUNNEL_HOST=https://...` or `tunnel config set host <URL>`).

No Node on the origin box? The agent has a pure-stdlib Python twin —
no pip, no clone needed (see `agent/README.md`):

```bash
curl -fsSL https://raw.githubusercontent.com/treaulab/infra/main/workers/edge/agent/agent.py -o /tmp/agent.py
ROOM=$(openssl rand -hex 16)
EDGE_URL="wss://go.treau.me/t/$ROOM/__agent" UPSTREAM="http://127.0.0.1:8080" python3 /tmp/agent.py
```

Prefer a bare `tunnel` on PATH? `npm link` (or keep the manual
`ln -sf "$PWD/bin/tunnel" ~/.local/bin/tunnel`), then drop the
`npm run tunnel --` prefix. Command parity with cloudflared:
`login ≈ tunnel login`, `info ≈ tunnel info`, `delete [-f]`,
`cleanup`, per-command `--help`, and `tunnel tunnel <sub>` nesting all work.
Bare `tunnel ssh` / `tunnel url` / `tunnel status` stay as aliases.

Where cloudflared keeps `~/.cloudflared/cert.pem` + `config.yml` + `<uuid>.json`,
we keep `~/.config/treaulab/config.json` (edge host)
+ `tunnels.json` (named tunnels + long URL IDs + ingress). Same jobs, JSON only.

Full command reference: `tunnel --help`. Manual (no-CLI) paths stay
documented in `TUNNEL.md` / `PIPE.md` as fallback.

## Local dev

```bash
cd workers/edge
npm install
npm run dev                      # http://127.0.0.1:8787 (no secrets needed)
# static:  curl -sI http://127.0.0.1:8787/
# relay:   ID=$(openssl rand -hex 16); npx wscat -c "ws://127.0.0.1:8787/ws/$ID"  (x2 terminals)
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
SSH-pipe usage: `PIPE.md` (`ssh lockedvps` via ProxyCommand).

Dry-run validation without uploading: `npm run deploy:dry`.

## DNS cutover (the zero-egress switch)

1. Dashboard → Workers → `treaulab-edge` → Custom Domains → add `treau.me`
   (+ `www.treau.me`; the Worker itself 301s www→apex).
2. Verify on the custom domain before touching anything else:
   `curl -sI https://treau.me/` → `200`, `/robots.txt`, `/sitemap.xml`,
   `/.well-known/security.txt`, `/nope-123` → `404` + `noindex`,
   `wss://treau.me/ws/<long-id>` echo across two clients.
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
  the old one. No open relay paths (short IDs → `404`).
* ToS: generic client-relay is fine; don't repurpose as a circumvention VPN
  without checking Workers/Zero Trust terms — sanctioned private access is
  Tunnel + Access/WARP instead.
