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

## Edge cutover (full-edge, zero Azure egress)
1. `cd workers/edge && npm install && npx wrangler login` (no secrets needed)
2. `npm run deploy:dry` (validate without uploading), then `npm run deploy`
   → note the `*.workers.dev` preview URL.
3. Verify on preview: `/` → `200`, `/robots.txt`, `/sitemap.xml`,
   `/.well-known/security.txt`, `/nope-123` → `404`+`noindex`, two `wscat`
   clients on `/ws/<long-id>` (e.g. `openssl rand -hex 16`) see each other's messages.
4. Dashboard → Worker → Custom Domains → add `treau.me` (+ `www.treau.me`).
   Re-run the same checks on the custom domain.
5. Azure is now out of the path (no code fetches any origin). Soak 48h with
   the VPS warm, then optionally stop Caddy / close NSG `80/443`.
   Rollback anytime = repoint DNS to the proxied VPS record (no code change).
