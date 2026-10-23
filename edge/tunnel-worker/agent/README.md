# tunnel agents (locked-down origin side)

Three flavors, same protocol, all dial **out** (outbound 443 + DNS only,
no inbound). Pick the first one that runs on your box. Azure TREAU is never
involved.

* **Static binary** (easiest where downloads are allowed): `tunnel-agent`
  needs no runtime at all — compiled from `agent.js` with
  `bun build --compile`, released per `agent-v*` tag (see
  `.github/workflows/agent-bin.yml`, Bun pinned):
  ```bash
  # linux amd64 (or tunnel-agent-linux-arm64):
  curl -fsSL https://github.com/treaulab/infra/releases/latest/download/tunnel-agent-linux-amd64 \
    -o /tmp/agent && chmod +x /tmp/agent
  /tmp/agent http://127.0.0.1:8080
  ```
* `agent.js` — Node 22+, zero deps: `node agent.js [UPSTREAM]`.
* `agent.py` — pure Python stdlib (no pip), for boxes with neither Node
  nor download freedom. See below.

No Node on the box? Use the Python twin instead — pure standard library
(no pip): `agent.py` mirrors `agent.js` exactly (same args, same protocol,
same heartbeat). `python3 --version` is the only requirement (3.8+).

```bash
# zero-clone one-liner (no git, no Node, no pip):
curl -fsSL https://raw.githubusercontent.com/treaulab/infra/main/edge/tunnel-worker/agent/agent.py \
  -o /tmp/agent.py
python3 /tmp/agent.py http://127.0.0.1:8080
# prints the public URL and serves it — browse https://go.treau.me/t/<id>/
```

* `agent.js` / `agent.py` — HTTP origins (default `http://127.0.0.1:8080`).
  Browsers use plain URLs, see `../TUNNEL.md`.
* `tcp-agent.js` — raw TCP, one dial to `HOST:PORT` (default
  `127.0.0.1:22`) per accepted stream: `node tcp-agent.js [HOST:PORT]`.
  Laptops connect via `tunnel ssh`, see `../PIPE.md`.

One file, zero dependencies, Node 22+. Runs **on the locked-down VPS** next to
whatever you want to expose (e.g. `python3 -m http.server 8080`), dials **out**
a single `wss:` control socket to the Worker, and serves the local upstream over
it. Needs only **outbound 443 + DNS** — no inbound ports. Your Azure TREAU box
is never involved (stays at zero egress).

## Run it

```bash
# on the locked-down VPS, next to your :8080:
node --version   # need >= 22 (global WebSocket + fetch)
node agent.js http://127.0.0.1:8080
# prints e.g. https://go.treau.me/t/<id>/ — browse it from anywhere.
# flags: [--host H] [--id ID] (reuse an id) [--json] (script output)
```

No args at all mints a fresh id and prints the URL (ephemeral — Ctrl-C
stops it). `--id <id>` reuses a room (e.g. the id from `tunnel info`).

Env knobs: `UPSTREAM` (default `http://127.0.0.1:8080`), `TUNNEL_HOST`
(default `https://go.treau.me`), `TUNNEL_URL` (full `wss://…/__agent` control
URL for systemd-style persistent mode; legacy `EDGE_URL` still read),
`UPSTREAM_TIMEOUT_MS`
(default `15000`, time to first byte — bodies stream with no total cap),
`NAME` (default hostname), `MAX_CONCURRENT` (default `16`),
`MAX_TUNNEL_BYTES` (default 500 MiB safety ceiling per stream).

Keepalive: both agents send a binary heartbeat frame every 20s,
so idle control sockets survive Cloudflare/NAT idle timeouts instead of
flapping with `1006` redials. Quiet tunnels stay up indefinitely.

## systemd (persist it)

```ini
# /etc/systemd/system/treaulab-tunnel.service
[Unit]
Description=treaulab tunnel agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/tunnel/agent.js http://127.0.0.1:8080 --id <long-id>
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now treaulab-tunnel.service
journalctl -u treaulab-tunnel.service -f
```

(The script already redials with backoff internally; `Restart=always` is
belt-and-braces.)

## Run it (raw TCP / ssh)

```bash
# on the locked-down box, next to sshd on 127.0.0.1:22:
node tcp-agent.js 127.0.0.1:22   # prints the box id; reuse via --id
```

Laptop side + full protocol: `../PIPE.md`. Same systemd shape as above with
`ExecStart=/usr/bin/node /opt/tunnel/tcp-agent.js`.

## Limits (v3 binary, no backward compat)

Binary multiplex over one control socket (11-byte frame header, 64 KiB
DATA, no Base64 tax), streaming both directions, 60 s sliding idle timeout,
500 MiB safety ceiling (`MAX_TUNNEL_BYTES`), up to `MAX_CONCURRENT` (16)
streams. HTTP uploads stream (chunked in Python, ReadableStream in Node);
visitor WS streams (`method: "WS"`) bridge to a local `ws://` upstream with
text frames preserved. One agent per room — a second
connect supersedes the first. Browsers get `502` when no agent is connected,
`504` on agent idle timeout. Agent mismatch (non-binary / wrong version)
closes the control socket `4400` — upgrade both sides together.
