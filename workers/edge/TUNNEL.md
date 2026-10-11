# Worse-cloudflared: HTTP reverse tunnel over one outbound WebSocket

Expose an origin that **cannot take inbound connections** (locked-down VPS with
`python3 -m http.server 8080`) behind a plain-HTTPS URL served 100% from the
edge. The origin dials **out**; browsers use normal HTTP. Azure TREAU is never
in the path (zero egress there by construction — no origin fetch exists in
`src/`).

```
locked VPS (:8080)                edge (treaulab-edge)              browser
  agent.js ──wss /t/TOK/room/__agent──> TunnelRoom (control socket)
                                                  ^ GET /t/TOK/room/<path>
                                                  │ envelope {id,method,path,headers,body} down the socket
                                                  └── plain HTTP response <── agent fetched 127.0.0.1:8080
```

## Endpoints (all gated by the same `RELAY_TOKEN` path secret)

* Agent (WS only): `wss://<host>/t/<TOKEN>/<room>/__agent`
* Browser (HTTP only, WS → `426`): `https://<host>/t/<TOKEN>/<room>/[...path]`
* `/t/<TOKEN>` alone = room `main`, upstream path `/`.

Status map: wrong token `403` · no agent `502` · agent timeout (20 s) `504` ·
body over cap `413` (request) / `502` (response) · bad method `405`.

## Envelope (v1, JSON text frames only)

Edge → agent:

```json
{"type":"req","id":"<uuid>","method":"GET","path":"/<upstream-path>?<query>",
 "headers":{"accept":"*/*"},"bodyB64":null}
```

Agent → edge:

```json
{"type":"res","id":"<uuid>","status":200,
 "headers":{"content-type":"text/html"},"bodyB64":"..."}
{"type":"err","id":"<uuid>","message":"upstream timeout"}
```

Also: agent `{"type":"hello","name":"...","version":1}` on connect (logged,
otherwise ignored); edge accepts `{"type":"pong"}`. Bodies are base64; hop
headers (`host, content-length, connection, transfer-encoding, ...`) are
stripped both ways and `Content-Length` is recomputed at the edge.

Rules: one agent per room (newcomer supersedes, old socket closed `4000`,
in-flight fails `502`); binary WS frames are ignored; unknown types ignored;
oversize response bodies fail `502` (never truncate).

## Run it (easy way — `tunnel` CLI)

```bash
tunnel quickstart --host https://treau.me   # once: host + tokens
tunnel create site1 --http --upstream http://127.0.0.1:8080
tunnel run site1        # on the locked box (or: tunnel url site1 for the raw EDGE_URL)
```

Then browse the printed URL. Manual equivalent (no CLI) below.

## Run it (manual)

1. Edge: `wrangler secret put RELAY_TOKEN` (once), deploy (`npm run deploy`
   or CI `edge.yml`), custom domain as usual.
2. Locked VPS: `python3 -m http.server 8080 --bind 127.0.0.1`, then
   `EDGE_URL="wss://treau.me/t/<TOKEN>/<room>/__agent" UPSTREAM="http://127.0.0.1:8080" node agent/agent.js`
   (see `agent/README.md` for systemd).
3. Browse: `https://treau.me/t/<TOKEN>/<room>/`. Verify Azure silence via
   `docker logs caddy` / Azure Monitor.

## Limits vs real cloudflared

HTTP only · ≤2 MiB requests / ≤5 MiB responses · 20 s per request · one
agent/room · no streaming/SSE/chunked video · deploys drop everything
(clients retry, agent redials). For raw TCP/UDP/SSH transparency use
`cloudflared` on the locked box instead — sanctioned, free, and still zero
for Azure. Generic client-relay abuse rules apply: secret-path gate, rotate
on leak, throttle if exposed beyond a few people.
