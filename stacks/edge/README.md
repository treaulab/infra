# stacks/edge

Public Azure VPS workload. Caddy serves the static site only.

```
caddy/
  compose.yml
  Caddyfile
  site/           static source of truth
  .env.example
```

Deploy with `just deploy-edge` or CI auto-deploy. There is deliberately no
homelab reverse proxy here: homelab services are reached over Tailscale.
