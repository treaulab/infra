# NAT box via cloudflared (stable treau.me, zero VPS touch)

Expose a computer behind NAT (no inbound, no port-forward) on stable
`treau.me` subdomains with stock `cloudflared`. The Azure VPS is never
touched and stays at zero egress: no `deploy.sh`, no ansible, no tofu,
no NSG/Caddy change. The NAT box dials **out** only (QUIC `7844/UDP`,
fallback `443/TCP`).

```
NAT box (:8080 + :22)              Cloudflare edge               visitor / laptop
  cloudflared ──out 7844/443──>  <UUID>.cfargotunnel.com
                                   ├─ box.treau.me ──> http://localhost:8080
                                   └─ ssh-box.treau.me ──> ssh://localhost:22
```

> Apex `treau.me` + `www` stay on the VPS/Caddy stack and the
> `treaulab-edge` Worker. Use subdomains here so DNS never collides.
> Suggested: `box.treau.me` (HTTP) + `ssh-box.treau.me` (SSH) — flat,
> short, no collision with apex/`www`/`go`.

## 0. Constraints (read first)

* **No VPS egress, no VPS touch.** Everything below runs on the NAT box
  (+ Cloudflare DNS for two CNAMEs). Verify afterwards: `docker logs caddy`
  on the VPS shows no new hits, Azure Monitor egress flat.
* **Stable domain:** `treau.me` must already be on Cloudflare Free
  (NS cutover done at registrar). No new domain needed.
* **Port 7844 open (outbound, NAT box only):** `cloudflared` needs
  outbound `7844/UDP` (QUIC) with `443/TCP` fallback. Inbound stays closed.
* **No credit card:** use the CLI-managed flow (§2). Never open the
  Zero Trust dashboard onboarding wizard — that is the screen that asks
  for card/PayPal even on the $0 plan.

## 1. Preflight (NAT box only, 30s)

```bash
# cloudflared present?
cloudflared --version || ./apps/cloudflared/install.sh

# outbound 7844 reachable? (any one OK; QUIC preferred, 443 fallback fine)
nc -uvz region1.v2.argotunnel.com 7844 || nc -vz region1.v2.argotunnel.com 443
ss -tlnp | grep -E '8080|22'   # your upstreams listening on localhost?

# local apps (examples — adjust to yours)
python3 -m http.server 8080 --bind 127.0.0.1 &
sudo systemctl status ssh --no-pager | head -5
```

If `nc` is missing, the fallback check is just: `cloudflared tunnel --loglevel debug run` later — look for `Registered tunnel connection` not `connection error`.

## 2. Create the named tunnel (card-free CLI flow)

Run on the NAT box (or any admin box with browser access — keys move once).
Nothing runs on the VPS.

```bash
# 1. One-time Cloudflare auth — opens a browser URL, pick treau.me.
#    Downloads ~/.cloudflared/cert.pem (account cert, keep private).
cloudflared tunnel login

# 2. Create the stable tunnel object (UUID + JSON credentials, no billing check).
cloudflared tunnel create nat-box
# → Created tunnel nat-box with id <YOUR-TUNNEL-UUID>
# → Credentials: ~/.cloudflared/<YOUR-TUNNEL-UUID>.json

# 3. Route both stable hostnames — NO manual dashboard DNS needed.
#    Each command creates the proxied CNAME (box → <UUID>.cfargotunnel.com).
cloudflared tunnel route dns nat-box box.treau.me
cloudflared tunnel route dns nat-box ssh-box.treau.me

# 4. Confirm DNS (should both answer, no dashboard clicks):
cloudflared tunnel route dns nat-box --overwrite-dns box.treau.me   # idempotent re-check
dig +short box.treau.me CNAME
dig +short ssh-box.treau.me CNAME
```

> DNS answer: you do **not** add `box.treau.me` by hand in the dashboard
> when you use `route dns` — it does the `CNAME → <UUID>.cfargotunnel.com`
> (proxied) for you. Dashboard `DNS > Records` is verify-only.
> Exception: token flow (`Networking > Tunnels > Create`) does **not**
> create DNS — then add the two CNAMEs by hand (or re-run `route dns`).

Token alternative (no `cert.pem`, better for automation/CI): dashboard
`Networking > Tunnels > Create` copies a `TUNNEL_TOKEN`, then run with
`cloudflared service install <TOKEN>`. Same zero-VPS result; pick one and
stick to it — do not mix cert + token for the same tunnel.

## 3. Configure (HTTP + SSH in one tunnel)

Copy the example and fill the UUID:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp apps/cloudflared/config.yml.example /etc/cloudflared/config.yml
sudo $EDITOR /etc/cloudflared/config.yml   # set tunnel: <YOUR-TUNNEL-UUID>
                                            # set credentials-file path
```

Result (`apps/cloudflared/config.yml.example` is the source of truth):

```yaml
tunnel: <YOUR-TUNNEL-UUID>
credentials-file: /root/.cloudflared/<YOUR-TUNNEL-UUID>.json

ingress:
  - hostname: box.treau.me
    service: http://localhost:8080
  - hostname: ssh-box.treau.me
    service: ssh://localhost:22
  - service: http_status:404   # catch-all required
```

Notes:

* HTTP `service` is plain `http://localhost:8080` even though visitors use
  `https://box.treau.me` — TLS terminates at Cloudflare edge.
* SSH `service` must be `ssh://localhost:22` (not `http://`). Raw TCP also
  works as `tcp://localhost:22`, but `ssh://` gives `cloudflared access ssh`
  semantics on the client.
* Keep the final `http_status:404` — `cloudflared` refuses to run without a
  catch-all.

## 4. Run (systemd, NAT box only)

```bash
# foreground smoke test first (Ctrl-C stops, nothing persists):
sudo cloudflared tunnel --config /etc/cloudflared/config.yml run nat-box
# → look for: INF Registered tunnel connection ... connIndex=0..3

# persist:
sudo cp apps/cloudflared/cloudflared.service.example /etc/systemd/system/cloudflared.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared.service
systemctl status cloudflared.service --no-pager
journalctl -u cloudflared.service -f
```

The unit already has `Restart=always` + `RestartSec=5`; `cloudflared`
itself redials with backoff, so quiet tunnels stay up through NAT idle
timeouts (QUIC keepalive, no inbound rule needed).

## 5. Use it

HTTP (any browser, anywhere):

```bash
curl -sI https://box.treau.me/   # → 200 via edge, origin is 127.0.0.1:8080
```

SSH (laptop needs `cloudflared` too — client side only):

```bash
# one-shot (no config change):
cloudflared access ssh --hostname ssh-box.treau.me --destination <anything>
# then ssh through it, e.g.:
ssh -o 'ProxyCommand cloudflared access ssh --hostname %h' user@ssh-box.treau.me

# persistent (recommended — see ssh-client.example):
cp apps/cloudflared/ssh-client.example ~/.ssh/config.d/box  # or append to ~/.ssh/config
ssh box    # Host box → ssh-box.treau.me via ProxyCommand
scp report.tgz box:/tmp/
sftp box
```

Verify server fingerprint out-of-band on first connect, as always.
`ServerAliveInterval 25` in the example keeps NAT/edge from idling the
SSH session out.

## 6. Prove zero VPS touch

```bash
# on the VPS (read-only checks, no change):
docker logs caddy --tail 20    # no new hits for box.treau.me / ssh-box.treau.me
# Azure portal → Monitor → egress flat for the window
# DNS: treau.me + www.treau.me unchanged (still VPS/edge); only the two
# subdomain CNAMEs point at <UUID>.cfargotunnel.com
```

Rollback = `cloudflared tunnel route dns delete` (or dashboard delete the
two CNAMEs) + `systemctl stop cloudflared` on the NAT box. VPS needs no
rollback because it was never changed.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR Failed to register tunnel` / QUIC timeout | outbound 7844 blocked | allow `7844/UDP` out on NAT box (or rely on `443/TCP` fallback; check `journalctl -u cloudflared`) |
| `box.treau.me` → Cloudflare 404 | ingress hostname mismatch | `hostname` in `config.yml` must exactly match the routed DNS name |
| `ssh-box.treau.me` hangs, no prompt | wrong service scheme | use `ssh://localhost:22`, not `http://`; client must use `cloudflared access ssh`, not plain `ssh ssh-box.treau.me:22` |
| `error parsing config: catch-all missing` | no final rule | keep `- service: http_status:404` last |
| Second `cloudflared run` kills the first | one tunnel = one active replica set | stop the old process, or use `--label` replicas intentionally |
| Dashboard asks for card/PayPal | you opened Zero Trust onboarding | close it; use CLI flow (§2) or `Networking > Tunnels` token flow — never the Zero Trust wizard |

## 8. When NOT to use this

* You want zero Cloudflare Tunnel dependency / no domain move: use the
  in-repo `workers/edge` tunnel instead (`workers/edge/TUNNEL.md` for HTTP,
  `workers/edge/PIPE.md` for SSH — outbound 443 only, long-URL auth).
* You want ephemeral sharing with no account at all:
  `cloudflared tunnel --url http://localhost:8080` (trycloudflare.com URL,
  dies with the process).
* Private-only access with SSO: that is Cloudflare Access/WARP (Zero Trust)
  — sanctioned, but it re-enters the billing-onboarding screen.

## Files

```
apps/cloudflared/
├── README.md                  # this runbook (VPS-untouched, card-free)
├── config.yml.example         # box.treau.me (http) + ssh-box.treau.me (ssh)
├── cloudflared.service.example# systemd unit for the NAT box
├── ssh-client.example         # laptop ~/.ssh/config snippet
└── install.sh                 # NAT-box installer + 7844 preflight
```
