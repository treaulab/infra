# stacks/homelab

Private workloads on the Proxmox Docker host. Nothing here is exposed to the
public internet; access is over Tailscale.

```
core/<service>/    shared plumbing (AdGuard, Uptime Kuma, ...)
apps/<app>/        self-hosted applications (Vaultwarden, Immich, ...)
```

Each app directory is self-contained:

```
apps/vaultwarden/
├── compose.yml
├── .env.example
└── .env            # gitignored
```

Deploy one app with `just deploy-home vaultwarden`. Keep app data in named
volumes or host paths that are covered by backups.
