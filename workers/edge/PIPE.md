# SSH pipe: raw TCP over WebSocket, multiplexed, cloudflared-shaped

`ssh lockedvps` in a normal laptop terminal, served 100% from the edge, with
the locked box dialing **out**. One room per box (`lockedvps1`, `lockedvps2`,
…). Azure TREAU is never in the path.

```
locked box (sshd :22)                    edge (PipeRoom)                  laptop
  tcp-agent ──wss /p/TOK/box/__agent──>  1 agent socket, N streams
    │ 1 TCP dial to :22 per stream        │  routes frames by stream id
    └──────── streams (framed) ──────────┴── streams ── ws-ssh-proxy (stdio)
                                                          │ ProxyCommand
                                                          └── ssh lockedvps
```

## Endpoints (gated by separate `PIPE_TOKEN`, never the relay token)

* Agent (WS only): `wss://<host>/p/<TOKEN>/<box>/__agent`
* Client (WS only, raw bytes): `wss://<host>/p/<TOKEN>/<box>`
* Wrong token → `403` (HTTP) / refused upgrade. No agent → client upgrade
  answers HTTP `502` (ssh fails fast, never hangs). Plain GET → `426`.

## Frame (binary only): `[type:u8][stream:u32be][payload]`

| Type | Value | Direction | Meaning |
|------|-------|-----------|---------|
| OPEN | 1 | client→edge (`stream`=0) | open a stream; edge assigns id, forwards |
| ACCEPT | 2 | agent→edge | TCP dial to `:22` succeeded |
| DATA | 3 | both | raw bytes (SSH ciphertext; never logged) |
| FIN | 4 | both | clean close, forward + tear down |
| RST | 5 | both | abort now |

Client→edge messages carry **no header** (raw payload, edge wraps DATA+id);
agent→edge is always framed. Caps: 256 KiB/frame (oversize → `RST` + close
`1009`); 10 s ACCEPT timeout (`1011`); one agent per room (newcomer
supersedes old with close `4000`, in-flight streams fail loud). Pairing
rebuilds from socket attachments after hibernation wake, so idle boxes stay
connected without billing.

Half-close: the laptop helper sends the exact 5-byte frame `[FIN,0,0,0,0]`
on stdin EOF (ssh parity for `ssh host cmd < file`) — the edge ends the
upstream TCP side but keeps delivering the response; exit is still driven by
the far-end close. A 5-byte DATA payload colliding with that pattern is a
2^-40 fluke.

## Laptop setup (the magic way — once)

```bash
node --version  # >= 20
mkdir -p ~/bin && cp workers/edge/bin/ws-ssh-proxy.js ~/bin/
```

```sshconfig
# ~/.ssh/config
Host lockedvps
  HostName lockedvps
  ProxyCommand node ~/bin/ws-ssh-proxy.js wss://treau.me/p/<PIPE_TOKEN>/lockedvps
  ServerAliveInterval 25
  ServerAliveCountMax 3
```

```bash
ssh lockedvps            # normal terminal ssh, host key TOFU under "lockedvps"
scp report.tgz lockedvps:/tmp/
sftp lockedvps
```

Verify the server fingerprint out-of-band on first connect, as always.
`ServerAliveInterval` keeps NAT/edge from idling the pipe out.

## Locked-box setup

```bash
node --version  # >= 20, and sshd listening on 127.0.0.1:22
EDGE_URL="wss://treau.me/p/<PIPE_TOKEN>/lockedvps/__agent" \
SSH_HOST="127.0.0.1" SSH_PORT="22" \
node agent/tcp-agent.js
```

systemd unit mirrors `agent/README.md` (same shape, `ExecStart` pointing at
`tcp-agent.js`, `Environment=EDGE_URL=…`). One agent per box; a second
connect supersedes the first.

## Failure table

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ssh` exits at once, proxy says `502`/closed | no agent in that room | start `tcp-agent.js` on the box |
| `403` / refused | wrong `PIPE_TOKEN` or path typo | compare URL with agent's `EDGE_URL` |
| session drops on every deploy | expected: deploys drop all pipes | reconnect (agent redials itself) |
| second terminal fails while first is open | shouldn't happen (multiplexed) — report as bug | check edge logs |
| hangs forever | shouldn't happen (fail-fast everywhere) — report as bug | `wrangler tail` |

## Limits (vs real cloudflared)

TCP only, no UDP (`mosh` out) · interactive ssh + scp/sftp in · bulk-GB
transfers work but each chunk is a billed DO event · all session bytes are
SSH ciphertext the edge can't read · Paid Workers assumed · same ToS posture
as `TUNNEL.md` (sanctioned private access is Tunnel + Access/WARP).
