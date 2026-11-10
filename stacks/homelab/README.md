# stacks/homelab

Docker Compose stacks for internal homelab hosts (`untrusted`
inventory group). These are **not** deployed through CI — use `just deploy-compose`.

Each subdirectory is a stack. Add it to a host's `compose_stacks:` in
`fleet/inventory/prod.yml` or deploy ad-hoc:

```bash
just deploy-compose beefyboi stack=jellyfin src=stacks/homelab/jellyfin
```

All stacks land under `/opt/stacks/<name>/` on the target host.
