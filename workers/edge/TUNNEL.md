# Worse-cloudflared: HTTP reverse tunnel over one outbound WebSocket

Expose an origin that **cannot take inbound connections** (locked-down VPS with
`python3 -m http.server 8080`) behind a plain-HTTPS URL served 100% from the
edge. The origin dials **out**; browsers use normal HTTP. Azure TREAU is never
in the path (zero egress there by construction — no origin fetch exists in
`src/`).

```
locked VPS (:8080)                edge (treaulab-edge)              browser
  agent.js ──wss /t/<roomId>/__agent──> TunnelRoom (control socket, websocket)
                                                  ^ GET /t/<roomId>/<path>
                                                  │ envelope {id,method,path,headers,body} down the socket
                                                  └── plain HTTP response <── agent fetched 127.0.0.1:8080
```

## Endpoints (long-URL-only, no token — the roomId is the secret)

* Agent (WS only): `wss://<host>/t/<roomId>/__agent`
* Browser (HTTP only, WS → `426`): `https://<host>/t/<roomId>/[...path]`
* `/t/<roomId>` alone = upstream path `/`.
* `roomId` = `[A-Za-z0-9_-]{20,64}`. Short IDs → `404`.

Status map: no agent `502` · agent timeout (20 s) `504` ·
body over cap `413` (request) / `502` (response) · bad method `405` ·
short/unknown room `404`.

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
tunnel create site1 --http --upstream http://127.0.0.1:8080   # host defaults to go.treau.me
tunnel run site1        # on the locked box (or: tunnel route site1 for the URL)
```

No Node on the box? `quick.py` is the same one-command share in pure
stdlib Python (single file, auto-fetches `agent.py`):

```bash
curl -fsSL https://raw.githubusercontent.com/treaulab/infra/main/workers/edge/agent/quick.py -o /tmp/quick.py
UPSTREAM="http://127.0.0.1:8080" python3 /tmp/quick.py
```

Then browse the printed long URL (`https://go.treau.me/t/<32-char-id>/`).
Manual equivalent (no CLI) below.

## Run it (manual)

1. Edge: deploy (`npm run deploy` or CI `edge.yml`), custom domain as usual.
   No secrets to set.
2. Locked VPS: `python3 -m http.server 8080 --bind 127.0.0.1`, then
   `ROOM=$(openssl rand -hex 16)` and pick an agent:
   * Node: `EDGE_URL="wss://go.treau.me/t/$ROOM/__agent" UPSTREAM="http://127.0.0.1:8080" node agent/agent.js`
   * Python, no installs: `EDGE_URL="wss://go.treau.me/t/$ROOM/__agent" UPSTREAM="http://127.0.0.1:8080" python3 agent/agent.py`
   (see `agent/README.md` for systemd + the zero-clone one-liner).
3. Browse: `https://go.treau.me/t/$ROOM/`. Verify Azure silence via
   `docker logs caddy` / Azure Monitor.

## Limits vs real cloudflared

HTTP only · ≤2 MiB requests / ≤5 MiB responses · 20 s per request · one
agent/room · no streaming/SSE/chunked video · deploys drop everything
(clients retry, agent redials). For raw TCP/UDP/SSH transparency use
`cloudflared` on the locked box instead — sanctioned, free, and still zero
for Azure. Abuse posture: long-URL obscurity only — rotate the room ID on
leak, throttle if exposed beyond a few people.
