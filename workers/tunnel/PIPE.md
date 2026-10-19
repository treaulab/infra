# SSH pipe: raw TCP over WebSocket, multiplexed, cloudflared-shaped

`ssh lockedvps` in a normal laptop terminal, served 100% from the Worker, with
the locked box dialing **out**. One room per box (`lockedvps1`, `lockedvps2`,
…). Azure TREAU is never in the path.

```
locked box (sshd :22)                    worker (PipeRoom)                laptop
  tcp-agent ──wss /p/TOK/box/__agent──>  1 agent socket, N streams
    │ 1 TCP dial to :22 per stream        │  routes frames by stream id
    └──────── streams (framed) ──────────┴── streams ── ws-ssh-proxy (stdio)
                                                          │ ProxyCommand
                                                          └── ssh lockedvps
```

## Endpoints (long-URL-only, no token — the box ID is the secret)

* Agent (WS only): `wss://<host>/p/<boxId>/__agent`
* Client (WS only, raw bytes): `wss://<host>/p/<boxId>`
* `boxId` = `[A-Za-z0-9_-]{20,64}`. Short IDs → `404`.
  No agent → client upgrade answers HTTP `502` (ssh fails fast, never hangs).
  Plain GET → `426`.

## Frame (binary only): `[type:u8][stream:u32be][payload]`

| Type | Value | Direction | Meaning |
|------|-------|-----------|---------|
| OPEN | 1 | client→worker (`stream`=0) | open a stream; worker assigns id, forwards |
| ACCEPT | 2 | agent→worker | TCP dial to `:22` succeeded, clears the 10 s accept timer |
| DATA | 3 | both | raw bytes (SSH ciphertext; never logged) |
| FIN | 4 | both | clean close, forward + tear down |
| RST | 5 | both | abort now |
| HB | 0 | agent→worker only | keepalive, dropped silently (no stream) |

Client→worker messages carry **no header** (raw payload, the Worker wraps DATA+id);
agent→worker is always framed. Caps: 256 KiB/frame (oversize → `RST` + close
`1009`); 10 s ACCEPT timeout (`1011`); one agent per room (newcomer
supersedes old with close `4000`, in-flight streams fail loud). Pairing
rebuilds from socket attachments after hibernation wake, so idle boxes stay
connected without billing.

Half-close: the laptop helper sends TEXT `__half_close__`
on stdin EOF (ssh parity for `ssh host cmd < file`) — the Worker ends the
upstream TCP side but keeps delivering the response; exit is still driven by
the far-end close. A text frame can never collide with binary DATA, so no
fluke window. The legacy exact 5-byte binary `[FIN,0,0,0,0]` is still
accepted for old proxies.

## Laptop setup (the easy way — `tunnel` CLI)

```bash
# one-time: symlink (host defaults to go.treau.me, no tokens)
ln -sf "$PWD/workers/tunnel/bin/tunnel" ~/.local/bin/tunnel  # ensure ~/.local/bin is on PATH
tunnel add lockedvps 127.0.0.1:22
tunnel ssh lockedvps   # that's it — ProxyCommand built inline
```

(Host defaults to `go.treau.me`; point elsewhere with
`--host H` or `TUNNEL_HOST=https://...`.)

`scp`/`sftp` ride the same path; for persistent config:
`tunnel ssh lockedvps --install`, then plain `ssh lockedvps` /
`scp f lockedvps:/tmp/`. `tunnel info lockedvps` shows agent liveness;
`tunnel doctor`/`logs` cover observability. Manual equivalent (no CLI) below.

## Laptop setup (manual, no CLI)

```bash
node --version  # >= 22
mkdir -p ~/bin && cp workers/tunnel/bin/ws-ssh-proxy.js workers/tunnel/lib/shared.js ~/bin/
# (ws-ssh-proxy.js imports ../lib/shared.js — keep the two files side by side,
# or just use `tunnel ssh` which handles this for you)
```

```sshconfig
# ~/.ssh/config
Host lockedvps
  HostName lockedvps
  ProxyCommand node ~/bin/ws-ssh-proxy.js wss://go.treau.me/p/<long-box-id>
  ServerAliveInterval 25
  ServerAliveCountMax 3
```

```bash
ssh lockedvps            # normal terminal ssh, host key TOFU under "lockedvps"
scp report.tgz lockedvps:/tmp/
sftp lockedvps
```

Verify the server fingerprint out-of-band on first connect, as always.
`ServerAliveInterval` keeps NAT from idling the pipe out.

## Locked-box setup

```bash
node --version  # >= 22, and sshd listening on 127.0.0.1:22
node agent/tcp-agent.js 127.0.0.1:22   # prints the box id
# reuse it on the laptop: tunnel add lockedvps 127.0.0.1:22 --id <printed-id>
# or skip minting: tunnel add lockedvps 127.0.0.1:22 on the laptop first,
# then serve it here with: tunnel up lockedvps
```

systemd unit mirrors `agent/README.md` (same shape, `ExecStart` pointing at
`tcp-agent.js`, `Environment=TUNNEL_URL=…`). One agent per box; a second
connect supersedes the first.

## Failure table

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ssh` exits at once, proxy says `502`/closed | no agent in that room | start `tcp-agent.js` on the box with the same box ID |
| `404` | short ID or path typo | IDs must be 20-64 chars; compare URL with agent's `TUNNEL_URL` |
| session drops on every deploy | expected: deploys drop all pipes | reconnect (agent redials itself) |
| second terminal fails while first is open | shouldn't happen (multiplexed) — report as bug | check worker logs |
| hangs forever | shouldn't happen (fail-fast everywhere) — report as bug | `wrangler tail` |

## Limits (vs real cloudflared)

TCP only, no UDP (`mosh` out) · interactive ssh + scp/sftp in · bulk-GB
transfers work but each chunk is a billed DO event · all session bytes are
SSH ciphertext the Worker can't read · Paid Workers assumed · same ToS posture
as `TUNNEL.md` (sanctioned private access is Tunnel + Access/WARP).
