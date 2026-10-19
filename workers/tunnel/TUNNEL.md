# Treau tunnel: HTTP + WebSocket reverse tunnel over one outbound socket

Expose an origin that **cannot take inbound connections** (locked-down VPS with
`python3 -m http.server 8080`) behind a plain public URL served 100% from the
Worker. The origin dials **out**; browsers use normal HTTP and WS clients use
normal WebSockets. Azure TREAU is never in the path (zero egress there by
construction — no origin fetch exists in `src/`).

```
locked VPS (:8080)                worker (treaulab-tunnel)            visitor
  agent.js ──wss /t/<roomId>/__agent──> TunnelRoom (binary multiplex, v3)
                                                   ^ GET /t/<roomId>/<path>
                                                   │ HEADERS + DATA frames down the socket
                                                   └── streaming HTTP response <── agent fetched 127.0.0.1:8080
                                                   ^ WS /t/<roomId>/<path>
                                                   └── duplex WS bridge <── agent dialed local ws://
```

## Endpoints (long-URL-only, no token — the roomId is the secret)

* Agent (WS only, binary v3): `wss://<host>/t/<roomId>/__agent`
* HTTP: `https://<host>/t/<roomId>/[...path]`
* WebSocket (all client paths upgrade-capable): `wss://<host>/t/<roomId>/[...path]`
* `/t/<roomId>` alone = upstream path `/`.
* `roomId` = `[A-Za-z0-9_-]{20,64}`. Short IDs → `404`.

Status map: no agent `502` · agent idle timeout (60 s sliding) `504` ·
body over ceiling `413` (request) / `502` (response) · bad method `405` ·
short/unknown room `404`. Probe `X-Tunnel-Probe: status` answers locally
at the Worker (never forwarded) so `tunnel info` can tell worker-404 from
upstream-404.

## Wire (v3 binary multiplex, no backward compat)

One agent WebSocket carries N streams. One WS message = exactly one frame:

```
[1B Type] [4B Stream ID] [2B Flags] [4B Length] [Payload (0 to 64 KiB)]
```

| Type | Value | Payload |
|------|-------|---------|
| HB | 0 | empty keepalive (`stream` 0) |
| HEADERS | 1 | opens a stream. Worker→agent `{method,path,headers}`; agent→worker `{status,headers}` (JSON UTF-8). `method: "WS"` = visitor WS stream |
| DATA | 2 | raw body bytes, zero Base64 tax |
| FIN | 3 | clean end of stream |
| RST | 4 | abort now (payload = optional UTF-8 reason) |
| HELLO | 5 | agent→worker `{name,version:3}` on connect (`stream` 0) |

Flags: `FIN (0x01)` = this DATA also ends the stream; `TEXT (0x02)` = this
DATA carries UTF-8 text (visitor/upstream text frames stay text end to end).

Rules: one agent per room (newcomer supersedes, old socket closed `4000`,
in-flight fails `502`); text WS frames on the agent socket are a protocol
violation (the Worker closes `4400` — fail loud, never hang); version mismatch on
HELLO closes `4400`. Request uploads stream via chunked framing (never
reassembled); upstream timeout (default 15 s) applies to first byte only.
Hop headers (`host, content-length, connection, transfer-encoding, ...`) are
stripped both ways; `Referrer-Policy: no-referrer` is forced on every
response so the room ID in the URL never leaks via `Referer`.

## Hibernation

The isolate stays awake while **any** stream is open and may sleep ($0)
only when the stream count is zero: each open stream holds a sliding 60 s
idle timer plus a shared `waitUntil` drain promise, so the event loop never
empties mid-stream. Long SSE/WS sessions therefore hold the isolate (billed
duration — the price of true streaming). Deploys/migrations still drop
everything; browsers retry and the agent redials with stable-reset backoff.

## Run it (easy way — `tunnel` CLI)

```bash
tunnel share http://127.0.0.1:8080   # prints the public URL, runs; host defaults to go.treau.me
# or named: tunnel add site1 http://127.0.0.1:8080 && tunnel up site1   # on the locked box
#           tunnel info site1        # the URL, from anywhere
```

## Run it (static binary, no runtime)

```bash
curl -fsSL https://github.com/treaulab/infra/releases/latest/download/tunnel-agent-linux-amd64 \
  -o /tmp/agent && chmod +x /tmp/agent
/tmp/agent http://127.0.0.1:8080
# (arm64 boxes: tunnel-agent-linux-arm64. Cut with `git tag agent-vX.Y.Z`.)
```

No Node on the box? `agent.py` is the same one-command share in
pure stdlib Python (single file, nothing else to download):

```bash
curl -fsSL https://raw.githubusercontent.com/treaulab/infra/main/workers/tunnel/agent/agent.py -o /tmp/agent.py
python3 /tmp/agent.py http://127.0.0.1:8080
```

Then browse the printed long URL (`https://go.treau.me/t/<32-char-id>/`).
WS apps connect to the same URL over `wss://`. Manual equivalent (no CLI)
below.

## Run it (manual)

1. Worker: deploy (`npm run deploy` or CI `tunnel.yml`), custom domain as usual.
   No secrets to set.
2. Locked VPS: `python3 -m http.server 8080 --bind 127.0.0.1`, then run an
   agent with no args (mints a room and prints the URL) or `--id` to reuse one:
   * Node: `node agent/agent.js http://127.0.0.1:8080`
   * Python, no installs: `python3 agent/agent.py http://127.0.0.1:8080`
   (see `agent/README.md` for systemd + the zero-clone one-liner).
3. Browse the printed `https://go.treau.me/t/<id>/`. Verify Azure silence via
   `docker logs caddy` / Azure Monitor.

## Limits vs real cloudflared

HTTP + WS passthrough (any token-shaped method except TRACE/TRACK;
`method: "WS"` streams bridge to a local `ws://` upstream, text frames
preserved) · binary streaming: 500 MiB safety ceiling, 60 s sliding idle
timeout, SSE/chunked OK, no Base64 tax · one agent/room, 16 concurrent
streams · deploys drop everything (clients retry, agent redials with
stable-reset backoff). For raw TCP/UDP/SSH transparency use
`cloudflared` on the locked box instead — sanctioned, free, and still zero
for Azure. Abuse posture: long-URL obscurity only — rotate the room ID on
leak, throttle if exposed beyond a few people.
