# tunnel agents (locked-down origin side)

Two scripts, both zero-dep Node 22+, both dial **out** (outbound 443 + DNS
only, no inbound). Azure TREAU is never involved.

* `agent.js` — HTTP origins (`UPSTREAM=http://127.0.0.1:8080`). Browsers use
  plain URLs, see `../TUNNEL.md`.
* `tcp-agent.js` — raw TCP, one dial to `SSH_HOST:SSH_PORT` (default
  `127.0.0.1:22`) per accepted stream. Laptops connect via
  `../bin/ws-ssh-proxy.js` as an ssh `ProxyCommand`, see `../PIPE.md`.

One file, zero dependencies, Node 22+. Runs **on the locked-down VPS** next to
whatever you want to expose (e.g. `python3 -m http.server 8080`), dials **out**
a single `wss:` control socket to the edge, and serves the local upstream over
it. Needs only **outbound 443 + DNS** — no inbound ports. Your Azure TREAU box
is never involved (stays at zero egress).

## Run it

```bash
# on the locked-down VPS, next to your :8080:
node --version   # need >= 22 (global WebSocket + fetch)
ROOM=$(openssl rand -hex 16)   # 32-char long URL ID, the secret
EDGE_URL="wss://treau.me/t/$ROOM/__agent" \
UPSTREAM="http://127.0.0.1:8080" \
node agent.js
```

Then from anywhere: `https://treau.me/t/$ROOM/` serves the `:8080`
content as plain HTTP. Same `$ROOM` for agent and browsers
(agent connects to `.../$ROOM/__agent`). No token.

Env knobs: `UPSTREAM` (default `http://127.0.0.1:8080`), `UPSTREAM_TIMEOUT_MS`
(default `15000`), `NAME` (default hostname, shown in edge logs).

## systemd (persist it)

```ini
# /etc/systemd/system/treaulab-tunnel.service
[Unit]
Description=treaulab tunnel agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/tunnel/agent.js
Environment=EDGE_URL=wss://treau.me/t/<long-room-id>/__agent
Environment=UPSTREAM=http://127.0.0.1:8080
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
BOX=$(openssl rand -hex 16)   # or reuse the ID from `tunnel create`
EDGE_URL="wss://treau.me/p/$BOX/__agent" \
SSH_HOST="127.0.0.1" SSH_PORT="22" \
node tcp-agent.js
```

Laptop side + full protocol: `../PIPE.md`. Same systemd shape as above with
`ExecStart=/usr/bin/node /opt/tunnel/tcp-agent.js`.

## Limits (v1, HTTP agent)

HTTP only (`GET HEAD POST PUT PATCH DELETE OPTIONS`), 2 MiB request bodies,
5 MiB response bodies, 20 s agent timeout. One agent per room — a second
connect supersedes the first. Browsers get `502` when no agent is connected,
`504` on agent timeout.
