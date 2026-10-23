# platform/cloudflare — the domain as code (minimal v1)

Read-only zone lookup for `treau.me`. **No records are managed yet.** Next
step is adopting DNS records one at a time, import-first, so `tofu plan`
shows no change before it ever shows a change.

Auth via ENVIRONMENT only (never in files, never the CI token from tunnel.yml):

```bash
export CLOUDFLARE_API_TOKEN="..."   # scoped to treau.me: Zone→DNS:Edit + Zone→Zone:Read
cd platform/cloudflare
tofu init
tofu plan                           # reads the zone only; 0 changes (needs token)
```

## Adding a record (adopt before managing)

```bash
# 1. declare it (see pattern below)
# 2. import the live record — plan MUST show no changes:
tofu import cloudflare_dns_record.www "$(tofu output -raw zone_id)/<record_id>"
tofu plan
```

```hcl
resource "cloudflare_dns_record" "www" {
  zone_id = data.cloudflare_zone.this.id
  name    = "www"     # relative to the zone; "@" for apex
  type    = "CNAME"
  content = "treau.me"
  ttl     = 1         # 1 = auto
  proxied = true
  comment = "managed by tofu"   # optional: marks it for humans in the dashboard
}
```

Rules: local state (gitignored), applies are human/terminal-only, one record
per change. Known gotchas when adopting: Workers custom-domain records and
cfargotunnel CNAMEs may be provider-managed — inspect in the dashboard
before declaring them here. CI (`tofu.yml`) runs fmt/validate only, no
credentials; applies never happen in CI.
