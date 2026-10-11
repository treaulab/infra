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

## Protocol

* Connect: `wss://<host>/ws/<TOKEN>` (room `main`) or `wss://<host>/ws/<TOKEN>/<room>`
  (`room` = `[A-Za-z0-9_-]{1,64}`). Anything sent is broadcast raw to every
  *other* socket in the same room. No persistence, no history.
* Heartbeat (doesn't wake a hibernated room): send exactly
  `__treaulab_ping__`, expect `__treaulab_pong__`.
* Wrong token → `403`. Non-websocket GET on a `/ws/` path → `426`.
* Soft caps (`src/room.js`): 1000 sockets/room, 1 MiB/message (close `1009`).

## Use it (`tunnel` CLI — the easy way)

```bash
ln -sf "$PWD/workers/edge/bin/tunnel" ~/.local/bin/tunnel  # once (ensure on PATH)
tunnel quickstart --host https://treau.me
tunnel create site1 --http --upstream http://127.0.0.1:8080
tunnel create lockedvps --tcp --to 127.0.0.1:22
tunnel list && tunnel doctor
tunnel run lockedvps     # on the origin box
tunnel ssh lockedvps     # from the laptop — no ~/.ssh/config editing
```

Full command reference: `tunnel --help`. Manual (no-CLI) paths stay
documented in `TUNNEL.md` / `PIPE.md` as fallback.

## Local dev

```bash
cd workers/edge
npm install
cp .dev.vars.example .dev.vars   # fill RELAY_TOKEN (any long random string)
npm run dev                      # http://127.0.0.1:8787
# static:  curl -sI http://127.0.0.1:8787/
# relay:   npx wscat -c 'ws://127.0.0.1:8787/ws/<TOKEN>/test'  (x2 terminals)
```

Generate a token: `openssl rand -hex 32`.

## Secrets / first deploy

```bash
cd workers/edge
npx wrangler login
npx wrangler secret put RELAY_TOKEN   # paste the openssl value (/ws/* + /t/*)
npx wrangler secret put PIPE_TOKEN    # a DIFFERENT value (/p/* terminals)
npm run deploy                        # → https://treaulab-edge.<acct>.workers.dev
```

CI (`edge.yml`, path-filtered to `workers/edge/**` + `apps/website/src/**`)
needs repo secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
`RELAY_TOKEN` / `PIPE_TOKEN` are set once via `wrangler secret put`, not
through CI. SSH-pipe usage: `PIPE.md` (`ssh lockedvps` via ProxyCommand).

Dry-run validation without uploading: `npm run deploy:dry`.

## DNS cutover (the zero-egress switch)

1. Dashboard → Workers → `treaulab-edge` → Custom Domains → add `treau.me`
   (+ `www.treau.me`; the Worker itself 301s www→apex).
2. Verify on the custom domain before touching anything else:
   `curl -sI https://treau.me/` → `200`, `/robots.txt`, `/sitemap.xml`,
   `/.well-known/security.txt`, `/nope-123` → `404` + `noindex`,
   `wss://treau.me/ws/<TOKEN>/smoke` echo across two clients.
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
* Abuse: secret-path gate is the only auth — rotate via
  `wrangler secret put RELAY_TOKEN` + update clients. No open relay paths.
* ToS: generic client-relay is fine; don't repurpose as a circumvention VPN
  without checking Workers/Zero Trust terms — sanctioned private access is
  Tunnel + Access/WARP instead.
