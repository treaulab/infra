# stacks

Declarative Docker Compose workloads that converge to `/opt/stacks/<name>/` across fleet hosts.

```
stacks/
├── edge/
│   └── caddy/             # Public Azure VPS web server (compose.yml, Caddyfile, site/)
└── homelab/
    └── jellyfin/          # Internal media stack for beefyboi
```

All stacks maintain 1:1 naming symmetry between Git and `/opt/stacks/<name>/` on the target host.
