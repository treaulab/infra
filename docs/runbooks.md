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

## Tailnet shell (hub + ONE burner spoke repo, NOT on VPS)

This repo is the **hub**: pure reusable logic, zero credentials, runs nothing
itself. A single burner-owned **public** repo (`dotfiles`: real dotfiles +
README stating the workflow's purpose + caller file) fans out N tenants, one
calling job per tenant — one repo, one account, no fleet (GitHub forbids
matrix on reusable-workflow calls, so tenants are explicit job blocks):
* Hub: `.github/workflows/tailnet-runner.yml` (`workflow_call`,
  inputs `mode` hourly|debug, `hostname-prefix`, `box-name`, `edge-url`,
  `quiet` (public-log scrub — spokes set `"true"`),
  `startup-delay-seconds` (stagger so jobs don't join at the same second),
  `tag` + `ts-oidc-client-id`/`ts-audience` (OIDC, preferred); secrets
  `TS_OAUTH_*` (fallback) or `TS_AUTHKEY_EPHEMERAL` (legacy) passed
  explicitly by the caller).
* Spoke template: `.github/workflows/tailnet-runner-caller.yml.example` —
  paste as `.github/workflows/tailnet-runner.yml`, replace `<PINNED_SHA>`,
  one calling job per tenant. Preferred: repo VARIABLES `TS_OIDC_CLIENT_ID`/
  `TS_AUDIENCE` (zero secrets, zero rotation); fallback per-tenant secrets
  (`TS_OAUTH_*` or `TS_AUTHKEY_<TENANT>`) —
  Environments are unreachable from reusable-call jobs, so they are not
  used. No `secrets: inherit`, never `@main`. Each calling job needs
  `permissions: id-token: write` for OIDC.
* Jobs run as `gh-<tenant>-<run-id>` (Tailscale SSH in). Hourly mode holds
  ~1 hour (heartbeat: timestamp + ping ok/fail + `curl box.treau.me` code
  every 5 min), then exits; debug holds up to 60 min for `tailscale ssh` in,
  `touch /tmp/kill` inside SSH exits early.
  NO ssh/scp smoke by design. Ceiling `timeout-minutes: 75`.
* Hard rules: triggers schedule + dispatch ONLY (never pull_request/push),
  fork-PR workflows require approval, cron offsets per job, runner stays idle.
* Launcher: `./scripts/gh-shell.sh [t1|t2]` dispatches, waits for
  `gh-<tenant>-*` on the tailnet, then `tailscale ssh` in.

1. Tailscale admin (once, preferred OIDC — no per-key ceremony):
   * Trust credentials → OIDC federated identity: issuer
     `https://token.actions.githubusercontent.com`, subject
     `repo:<owner>@<owner-id>/<repo>@<repo-id>:*` (immutable format — copy
     the exact `Received ... from issuer` value from a failed run and replace
     the tail with `*`; e.g. `repo:andrewwang2161@336265156/dotfiles@1419863416:*`),
     tags `tag:ci-ephemeral`, scope
     `auth_keys` write. Copy Client ID + Audience into spoke repo VARIABLES.
   * Access Controls → `tagOwners: {"tag:ci-ephemeral": ["you"]}`, SSH
     accept `src: [you]` → `dst: [tag:ci-ephemeral]`, users
     `["runner","root"]`. No exit-node / subnet routes.
   * Legacy path (only if OIDC unavailable): Settings → Keys → reusable
     **ephemeral** key per tenant, own tag, short expiry → value goes ONLY
     to tofu (never pasted, never chat).
   * Name the NAT box `box` (`tailscale up --hostname=box`).
2. Spoke repo(s) (PUBLIC dotfiles + README + caller file, pin `@<sha>`):
   * One burner → one spoke repo (e.g. `andrewwang2161/dotfiles`). Second
     burner → second spoke repo, same template, its OWN OIDC vars (each
     tailnet trusts its own repo subject; vars are per-repo).
   * OIDC (preferred): set repo VARIABLES `TS_OIDC_CLIENT_ID`/`TS_AUDIENCE`,
     no grant windows, no secrets.
   * Bumping the hub pin on hub updates — one command per spoke, run as the
     account that owns it (no cross-account pushes, no standing edge):
     ```bash
     ./scripts/bump-spoke.sh andrewwang2161/dotfiles <hub-sha>  # as burner 1
     ./scripts/bump-spoke.sh <burner2>/dotfiles <hub-sha>        # as burner 2
     # or without switching: GH_TOKEN="$(gh auth token --user X)" ./scripts/bump-spoke.sh ...
     ```
     The script renders the caller template with the new SHA, skips when
     already pinned, and never touches vars/secrets.
   * Legacy authkey path only: invite `slancj` Write for the
     grant window → `tofu/tailnet` apply writes all secrets (never rendered)
     → **revoke the grant immediately** (re-grant ~30s per future rotation).
    * Retired: the old `TS_AUTHKEY_EPHEMERAL` + `BURNER_GH_USER` on `infra`
      and any standing grants — `infra` holds no credentials, no spoke
      carries a standing cross-account edge.
3. Use: hourly schedule fires on its own (watch heartbeats); debug via Run
   workflow → tenant=all or one → `tailscale ssh runner@gh-<t>-<run-id>`.
4. Rollback per tenant: revoke its key (+ delete its repo secret).
   Sibling tenants untouched. Full retreat: delete spoke repo.
5. Warm-up (once, new accounts): days of human commits → debug dispatches
   → daily → hourly. New-account-to-instant-24/7 is the most bot-shaped
   sequence available; don't run it. VPS untouched throughout
   (`docker logs caddy` silent).

## Secrets (SOPS+age — committed config secrets only)

Scope discipline: SOPS is for **versioned config values** (safe in git as
ciphertext). Ceremony ephemera (OAuth secrets, PATs) stay terminal-env +
shred; standing tokens stay keyring/Bitwarden; private keys stay files.
Never SOPS a private key or a runtime-scoped PAT.

Setup (done once, this box): age identity generated (`age-keygen`),
**secret in OS keyring** (`service=treaulab-sops`, `key=age-identity`,
never displayed/stored elsewhere), **pubkey committed** in `.sops.yaml`
(`age1ztexay0xhcwssf5kp9r5umjrgg7e80et8xy4k4k729ghr80xha5q07jn0r`).
Per-account recipients get appended there as spokes publish pubkeys.

Use (any `*.enc.yaml`, values encrypted, keys/structure clear):
```bash
export SOPS_AGE_KEY="$(secret-tool lookup service treaulab-sops key age-identity)"
sops -d sops-demo.enc.yaml        # roundtrip test: readable = identity works
sops -e plain.yaml > x.enc.yaml   # encrypt (shred plain after)
sops rotate -i x.enc.yaml         # rotate data key, verify decrypt after
unset SOPS_AGE_KEY
```
Live demo: `sops-demo.enc.yaml` (fake values, real workflow —
roundtripped + rotated at adoption). Delete it once real consumers exist.

Crown-jewel warning: the age secret key decrypts **all history**
including rotated-out values (no forward secrecy). Back it up
independently of this box (paper/Bitwarden) or accept total loss on
keyring failure — either is a conscious choice, document which. Losing it
means re-encrypting everything to a new identity, not recovery.

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
