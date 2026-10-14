# Runbooks

## First boot (existing manual VPS -> IaC)
1. VPS already up: skip `tofu apply`. Just confirm the NSG allows
   `22/tcp` (your IP), `80/tcp`, `443/tcp`, then go to step 2.
   Adopt `tofu/` later via `tofu import` (RG/VNet/NSG/PIP/NIC/VM) once stable —
   back up first, review `tofu plan` carefully so nothing gets replaced.
2. Point DNS: `<domain> -> <public_ip>` (tofu output).
3. `./scripts/deploy.sh prod` — rsyncs apps + Caddyfile, `docker compose up`.
4. Verify: `curl -sI https://<domain>/` (should be 200), `docker logs caddy --tail 20`.

## Backups (v1 manual)
App data lives in Docker named volumes (`caddy-data`, `caddy-config`).
Snapshot example: `docker run --rm -v caddy-data:/data -v /opt/treaulab/backups:/backup ubuntu tar -czf /backup/caddy-data-$(date +%F).tar.gz -C /data .`. Keep offsite.

## Upgrade Caddy
Bump `CADDY_VERSION` in the inventory (`ansible/inventory/prod.yml`), re-run
`./scripts/deploy.sh prod` (or `ansible-playbook -i ansible/inventory/prod.yml ansible/playbooks/site.yml`), check `docker logs caddy`.

## NAT box (cloudflared, stable treau.me, VPS untouched)

Computer behind NAT exposing **both** HTTP + SSH on stable subdomains,
zero VPS egress, no card (CLI flow). Full runbook lives in
`apps/cloudflared/README.md` — summary:

1. On the NAT box only: `./apps/cloudflared/install.sh --check-only`
   (needs outbound `7844/UDP` + `443/TCP`; inbound stays closed).
2. `cloudflared tunnel login && cloudflared tunnel create nat-box`
   then `route dns nat-box box.treau.me` + `route dns nat-box ssh-box.treau.me`.
3. Copy `apps/cloudflared/config.yml.example` → `/etc/cloudflared/config.yml`,
   fill `<YOUR-TUNNEL-UUID>` (ingress: `box` → `http://localhost:8080`,
   `ssh-box` → `ssh://localhost:22`, plus `http_status:404` catch-all).
4. Smoke test `cloudflared tunnel --config /etc/cloudflared/config.yml run nat-box`,
   then persist via `apps/cloudflared/cloudflared.service.example` → systemd.
5. Laptop SSH via `apps/cloudflared/ssh-client.example`
   (`ProxyCommand cloudflared access ssh --hostname %h`).
6. Prove VPS silence: `docker logs caddy --tail 20` shows nothing new.
   Rollback = delete the two CNAMEs + stop NAT-box service (VPS unchanged).

## Tailnet shell (hub + per-account spokes, NOT on VPS)

This repo is the **hub**: pure reusable logic, zero credentials, runs nothing
itself. Each GitHub account owns a **spoke** repo that calls the hub:
* Hub: `.github/workflows/tailnet-shell-reusable.yml` (`workflow_call`,
  inputs `mode` hourly|debug, `hostname-prefix`, `box-name`, `edge-url`;
  secret `TS_AUTHKEY_EPHEMERAL` passed explicitly by the caller).
* Spoke template: `.github/workflows/tailnet-shell-caller.yml.example` —
  paste as `.github/workflows/tailnet-shell.yml` in the account repo,
  replace `<PINNED_SHA>`, set that repo's own secret. No `secrets: inherit`.
* Spoke runs as `gh-<acct>-<run-id>` (Tailscale SSH in). Hourly mode holds
  ~1 hour (dummy heartbeat: timestamp + `ping box` + `curl box.treau.me`
  every 5 min), then exits; debug mode holds ~17 min for `tailscale ssh` in.
  NO ssh/scp smoke by design. Ceiling `timeout-minutes: 75`.

1. Tailscale admin (once per account key):
   * Access Controls → `tagOwners: {"tag:ci-<acct>": ["you"]}`, SSH accept
     `src: [you]` → `dst: [tag:ci-<acct>]`, users `["runner","root"]`.
     No exit-node / subnet routes. (Pilot: `tag:ci-burner`.)
   * Settings → Keys → reusable **ephemeral** key per account, own tag,
     short expiry → copy `tskey-auth-...`.
   * Name the NAT box `box` (`tailscale up --hostname=box`).
2. Spoke repo (as that account, terminal, no GUI; pilot: `andrewwang2161/tailnet-shell`, private):
   * Create repo, paste caller file, pin `@<sha>`.
   * `gh secret set TS_AUTHKEY_EPHEMERAL` (that account's own key).
   * No access grants on `treaulab/infra` needed (public read suffices).
   * Retired: the old `TS_AUTHKEY_EPHEMERAL` + `BURNER_GH_USER` on `infra`
     and burner's Write grant were removed — `infra` holds no credentials.
3. Use: hourly fires on its own in the spoke (watch heartbeats); debug via
   Run workflow in the spoke → `tailscale ssh runner@gh-<acct>-<run-id>`.
4. Rollback per account: delete spoke repo + revoke its key. Hub and
   sibling accounts untouched. VPS untouched throughout
   (`docker logs caddy` silent).

## Edge cutover (full-edge, zero Azure egress)
1. `cd workers/edge && npm install && npx wrangler login` (no secrets needed)
2. `npm run deploy:dry` (validate without uploading), then `npm run deploy`
   → note the `*.workers.dev` preview URL.
3. Verify on preview: `/` → `200`, `/robots.txt`, `/sitemap.xml`,
   `/.well-known/security.txt`, `/nope-123` → `404`+`noindex`, plus
   `tunnel doctor` against the preview host (all PASS).
4. Dashboard → Worker → Custom Domains → add `treau.me` (+ `www.treau.me`).
   Re-run the same checks on the custom domain.
5. Azure is now out of the path (no code fetches any origin). Soak 48h with
   the VPS warm, then optionally stop Caddy / close NSG `80/443`.
   Rollback anytime = repoint DNS to the proxied VPS record (no code change).
