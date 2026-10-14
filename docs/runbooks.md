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

## Tailnet shell (hourly 1h runs + debug dispatch, NOT on VPS)

GitHub-hosted job joins your tailnet as `gh-ci-<run-id>` (Tailscale SSH in).
Two modes in `.github/workflows/tailnet-shell.yml`:
* Hourly (`schedule`, minute 7): dummy heartbeat task holds ~1 hour
  (~55 min loop: timestamp + `ping box` + `curl box.treau.me` every 5 min),
  then exits for the next cycle. Repeats 24/7, no actor gate (schedule
  events have no human actor). Ceiling `timeout-minutes: 75`.
* Debug (dispatch, burner `andrewwang2161` only): quick filler + ~17 min
  hold so you can `tailscale ssh runner@gh-ci-<run-id>` in.

1. Tailscale admin (once):
   * Access Controls → `tagOwners: {"tag:ci-ephemeral": ["you"]}`, SSH accept
     `src: [you]` → `dst: [tag:ci-ephemeral]`, users `["runner","root"]`.
     No exit-node / subnet routes.
   * Settings → Keys → reusable **ephemeral** key, tag `tag:ci-ephemeral`,
     short expiry → copy `tskey-auth-...`.
   * Name the NAT box `box` (`tailscale up --hostname=box`).
2. GitHub repo `treaulab/infra` (terminal, no GUI):
   * `gh secret set TS_AUTHKEY_EPHEMERAL --repo treaulab/infra`
   * `gh variable set BURNER_GH_USER --body andrewwang2161 --repo treaulab/infra`
     (both already set — verify with `gh secret/variable list`).
   * Burner `andrewwang2161` needs Write on the repo (dispatch only).
3. Use: hourly runs fire on their own (Actions → `tailnet-shell` → watch
   heartbeats in logs). Debug: as `andrewwang2161`, Run workflow →
   read the `100.x` IP → `tailscale ssh runner@gh-ci-<run-id>`.
   NO ssh/scp smoke by design.
4. Rollback: disable the schedule (comment the `cron` line) or cancel runs
   (nodes vanish, ephemeral key) + revoke the auth key.
   VPS untouched throughout (`docker logs caddy` silent).

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
