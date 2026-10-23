# stacks/public

Public Azure VPS workload. Caddy serves the static site only.

```
caddy/          compose.yml + Caddyfile + .env
website/src/    static source of truth (rsync'd to the VPS)
```

Deploy with `just deploy-public`. There is deliberately no homelab reverse
proxy here: homelab services are reached over Tailscale until a Cloudflare
Tunnel is added later.
