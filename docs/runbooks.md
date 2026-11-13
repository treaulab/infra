# Runbooks

## First boot (existing manual VPS -> IaC)

1. Confirm the Azure NSG allows `22/tcp` (your IP), `80/tcp`, `443/tcp`.
   Keep 22 open until Tailscale access is proven.
2. Copy and fill:
   ```bash
   cp fleet/inventory/prod.yml.example fleet/inventory/prod.yml
   # Caddy .env is rendered on the VPS by the deploy playbook.
   ```
3. If the VPS exists, skip `tofu apply`; adopt it later via `tofu import`
   once stable. Back up state first and review `tofu plan` so nothing is
   replaced.
4. Configure the host:
   ```bash
   just setup
   just converge vps          # base + Tailscale + Docker
   just deploy-public         # Caddy + static site
   ```
5. Verify: `curl -sI https://<domain>/` (200), `docker logs caddy --tail 20`.
6. Add cluster nodes to `fleet/inventory/prod.yml` using their MagicDNS names
   or `100.x` addresses, then `just converge cluster` and `just k3s`.

## Deploy / upgrade Caddy

- Website-only change: `just deploy-public`; Ansible syncs the site without
  restarting Caddy.
- Caddyfile change: same command; an Ansible handler recreates the container.
- Compose/`.env` change: same command; the compose convergence applies it
  (typically by recreating the container when its config hash changes).
- Version bump: update `caddy_version` in `fleet/inventory/prod.yml`, then
  `just deploy-public`. For a one-off, run the playbook with
  `-e caddy_version=...` (or use the compatibility wrapper, which still maps
  `CADDY_VERSION`). The playbook templates `stacks/edge/caddy/.env` on the
  host from inventory variables.
- Check logs: `ssh <vps> 'docker logs caddy --tail 50'`.
- The `deploy-public` playbook also waits for `https://<domain>/` to return
  `200`; CI uses the same external check.

Caddy serves `/srv/website` from `stacks/edge/caddy/site`. It has no
`reverse_proxy` blocks; homelab traffic does not transit the VPS.

## Backups

Caddy data lives in Docker named volumes (`caddy-data`, `caddy-config`).
Homelab app data should live in named volumes or host paths outside the
synced stack directory (deploy uses `rsync --delete`).

Example Caddy snapshot:

```bash
docker run --rm -v caddy-data:/data -v /opt/stacks/backups:/backup ubuntu \
  tar -czf /backup/caddy-data-$(date +%F).tar.gz -C /data .
```

Keep backups off-machine.

## Tailnet shell (hub + ONE burner spoke repo, NOT on the VPS)

This repo is the **hub**: reusable logic, zero credentials, runs nothing
itself. A burner-owned **public** repo (`dotfiles`) fans out N tenants, one
calling job per tenant.

- Hub: `.github/workflows/tailnet-runner.yml` (`workflow_call`, inputs
  `mode` hourly|debug, `hostname-prefix`, `box-name`, `edge-url`, `quiet`,
  `startup-delay-seconds`, `tag`, `ts-oidc-client-id`/`ts-audience`; secrets
  `TS_OAUTH_*` or `TS_AUTHKEY_EPHEMERAL`).
- Spoke template: `.github/workflows/tailnet-runner-caller.yml.example`.
- Launcher: `./tools/gh-shell.sh [t1|t2]`.
- Bump pin: `./tools/bump-spoke.sh <owner/repo> <hub-sha>`.

1. Tailscale admin (once, preferred OIDC): Trust credentials -> OIDC federated
   identity, issuer `https://token.actions.githubusercontent.com`, subject
   `repo:<owner>@<owner-id>/<repo>@<repo-id>:*`, tags `tag:untrusted`,
   scope `auth_keys` write. Put Client ID + Audience in spoke repo VARIABLES.
   Access Controls: `tagOwners` for `tag:untrusted`, SSH accept from you to
   that tag, users `["runner","root"]`. Name the NAT box `box`.
2. Spoke repo (public dotfiles + README + caller file), pin
   `@<sha>`, set `TS_OIDC_CLIENT_ID`/`TS_AUDIENCE`. Legacy authkey path only
   if OIDC is unavailable.
3. Use: hourly schedule, or dispatch a tenant and `tailscale ssh` in.
4. Rollback per tenant: revoke its key/secret, sibling tenants untouched.
5. Warm-up (new accounts): human commits -> debug dispatches -> daily ->
   hourly. The VPS stays untouched.

Policy/keys root: `platform/tailscale`. Applies are human/terminal with
short-lived credentials; CI is fmt/validate only. The local state contains a
live key — see "OpenTofu state" below.

## Secrets (`.env`/`.envrc` local, hidden prompts for one-offs)

SOPS/age was removed for now. Plaintext local files are a deliberate
temporary tradeoff:

- `.env` is gitignored globally; commit `.env.example` only. It is for
  runtime stack config.
- `.envrc` is gitignored, mode `0600`, and loaded by `direnv` for local
  provider credentials:
  ```bash
  cp .envrc.example .envrc
  chmod 600 .envrc
  # fill in the values locally
  direnv allow .
  ```
  It is plaintext on disk. Move high-value tokens to GNOME Keyring
  (`secret-tool`) or 1Password when convenient. Never commit it.
- Caddy `.env` is non-secret (domain/email/version/IP).
- Homelab/app `.env` files may contain secrets: keep them mode `0600`, never
  log them, and never commit them. `just secrets-check` guards tracked
  `.env` and `.envrc`.
- One-off credentials can still be entered with a hidden prompt instead of
  `.envrc`; never put provider tokens in `.env` or tfvars:
  ```bash
  printf 'Cloudflare API token: '
  read -s CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
  echo
  ```
  Repeat the same pattern for `GITHUB_TOKEN`, `TAILSCALE_API_KEY`, or
  `TAILSCALE_OAUTH_CLIENT_SECRET`.
- Keep GitHub dynamic rather than storing a static token:
  ```bash
  GITHUB_TOKEN="$(gh auth token --user slancj)" just plan tailscale
  ```
- `deploy.yml` creates a CI inventory from GitHub Secrets; the
  `deploy-public` playbook templates the Caddy `.env` on the host.
- Do not paste secrets into chat or issue trackers. A future SOPS/age or
  Docker-secrets migration can replace this without changing stack layouts.

## OpenTofu state (local for now)

Every root under `platform/` uses local state, which is gitignored:

- Back up `terraform.tfstate` and `.backup` off-machine before any move.
- Keep state mode `0600` and its directory `0700`.
- Never run concurrent applies; CI only runs `fmt`/`validate`.
- After moving a root: move the state file with the code, delete the old
  `.terraform/` (absolute paths), run `tofu init` in the new root, then
  `tofu state list` and `tofu plan`. **Do not apply until the plan is empty.**
- `platform/tailscale/terraform.tfstate` holds a live tailnet key. Move it
  last, verify the checksum, and run `tofu state list`; run `tofu plan` as soon
  as the required credentials are available. Stop if the plan is not empty.
- A remote encrypted backend can come later; migrate `tailscale` first with
  `tofu init -migrate-state`.

## DPI Circumvention (ByeDPI vs Zapret2)

Russian ISP TSPU (Roskomnadzor) resets TLS connections during SNI Client Hello inspection on services like Tailscale (`pkgs.tailscale.com`), Cloudflare (`pkg.cloudflareclient.com`), Docker Registry, and GitHub raw blobs.

The infrastructure uses a two-tier circumvention model:

1. **Router / Gateway Level (`192.168.10.2` / `192.168.10.254` OpenWrt)**:
   - Runs **`zapret2`** (`nfqws2`) at the network boundary.
   - Handles network-wide NFQUEUE desync for all devices routing via `.2` (Proxmox VMs `mercury`, `venus`, phones, IoT) without client software.
   - Declared in code via OpenTofu ([platform/proxmox/openwrt.tf](file:///home/trueking/Safe/Proj/infra/platform/proxmox/openwrt.tf)) and converged via Ansible ([fleet/roles/openwrt_gateway](file:///home/trueking/Safe/Proj/infra/fleet/roles/openwrt_gateway) via `just gateway`).
   - Mirror repository: [github.com/slancj/zapret2](https://github.com/slancj/zapret2).
   - Documented in `~/Safe/documented/router-192.168.10.254/`.

2. **Workstation Fleet (`untrusted`: beefyboi, scrawnyboi, nucboi)**:
   - Workstations use direct ISP router gateway `192.168.10.1` (avoids dependence on PVE router VM).
   - Runs **`byedpi`** (`ciadpi` v0.17.3) locally via Ansible:
     - `byedpi-transparent.service`: Transparent proxy on `127.0.0.1:1081` (`--oob 1+s --auto=torst`).
     - `byedpi-nat.service`: Iptables redirect for outbound ports 80 & 443 with private LAN and Tailscale (100.64.0.0/10, tailscale0) exclusions.
     - `byedpi-socks.service`: SOCKS5 proxy on `127.0.0.1:1080`.
   - **Why `--oob 1+s --auto=torst` is optimal**:
     - `--oob 1+s`: Splits TLS Client Hello 1 byte after the SNI offset and marks it with TCP Urgent flag. TSPU DPI fails stream reassembly, while legitimate servers process it cleanly.
     - `--auto=torst`: Zero overhead on unblocked connections; only activates desync when TSPU sends a TCP RST, then caches it per destination IP.
     - **No build tools or hostlists**: Avoids compilation from source, Lua scripts, or stale hostlists that cause silent failures.

### Operations
- Enabled per-group via `enable_byedpi: true` in `fleet/inventory/prod.yml`.
- Runs automatically before apt/docker/tailscale in `just untrusted` or `just converge <host>`.
- Converge or restart standalone: `just byedpi [node]`.
- Health check: `ssh <node> "curl -Iv https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg"`.

### Known Incompatibility: Akamai CDN, Quay.io & TCP OOB Desync
Both `zapret2` (`--lua-desync=oob:urp=midsld:char=a`) and `byedpi` (`--oob 1+s`) inject an out-of-band byte marked with the TCP Urgent Pointer (`URG`) flag to defeat DPI stream reassembly.
- **Root Cause**: Akamai CDN edge servers (`23.0.0.0/8`, hosting `cdn01.quay.io`, Apple CDN, GitHub release assets) drop incoming TCP segments carrying the `URG` flag or an active urgent pointer.
- **Symptom**: TLS handshakes hang for 10 seconds and abort with `net/http: TLS handshake timeout`. In Kubernetes, container image pulls from `quay.io` (such as `quay.io/metallb/controller:v0.16.2`) fail with `ImagePullBackOff`.
- **Upstream Status**: Akamai CDN and Quay.io are **unblocked** by Russian ISP DPI / TSPU. Desync is unnecessary and destructive for them.
- **Resolution (Gateway Router `192.168.10.254`)**:
  - Add `23.0.0.0/8` to `/opt/zapret2/ipset/zapret-ip-exclude.txt`.
  - Add `quay.io` and `cdn01.quay.io` to `/opt/zapret2/ipset/zapret-hosts-user-exclude.txt`.
  - Live reload: `nft add element inet zapret2 nozapret { 23.0.0.0/8 }`.
- **Resolution (Workstations `byedpi`)**:
  - `/usr/local/sbin/byedpi-nat.sh` explicitly bypasses `23.0.0.0/8` before redirecting ports 80/443:
    ```bash
    iptables -t nat -I OUTPUT -d 23.0.0.0/8 -j RETURN
    ```
- **Impact on Consumer Services (TikTok & Roblox)**:
  - **TikTok**: `www.tiktok.com` resolves directly to Akamai EdgeSuite (`23.199.54.x` within `23.0.0.0/8`). With `23.0.0.0/8` excluded from NFQUEUE desync, TLS 1.3 handshakes complete instantly without OOB handshake timeouts.
  - **Roblox**: `www.roblox.com` resolves to Roblox edge IPs (`128.116.48.x`), which are not in the Akamai block. Traffic is processed by Zapret2 OOB desync (`--lua-desync=oob:urp=midsld:char=a`), completing clean TLS 1.3 handshakes and bypassing TSPU RST injection.
- **Admission Webhook Impact**: If `metallb-controller` is stuck in `ImagePullBackOff` due to the Akamai timeout, applying `IPAddressPool` or `L2Advertisement` manifests will fail with `failed calling webhook ... no endpoints available for service "metallb-webhook-service"`. The controller pod must be healthy before pool CRDs can be applied.

## Proxmox VE & Homelab K3s Cluster

Proxmox VE runs on bare-metal host `entia` (`192.168.10.10:8006`). Virtualization is automated via OpenTofu; cluster convergence and workload deployment are managed via Ansible and kubectl.

### 1. Provision VMs (OpenTofu)
1. Ensure credentials exist in `.envrc` (`direnv allow .`):
   ```bash
   export PROXMOX_VE_ENDPOINT="https://192.168.10.10:8006/"
   export PROXMOX_VE_API_TOKEN="terraform@pve!tofu-token=<token>"
   export PROXMOX_VE_INSECURE="true"
   ```
2. Verify plan:
   ```bash
   just plan proxmox
   ```
3. Apply to provision the VMs on `local-zfs`:
   ```bash
   tofu -chdir=platform/proxmox apply
   ```

### 2. Converge K3s Cluster (Ansible)
Deploy K3s on `mercury` (server), `venus` (agent), and `earth` (agent):
```bash
just k3s
```
*This command executes `playbooks/host.yml --limit cluster`, provisions systemd services, connects agents with the cluster token, and generates `.kube/k3s.yaml`.*

### 3. Deploy Kubernetes Workloads
1. Place declarative manifests in `kubernetes/manifests/<name>.yaml`.
2. Apply manifests:
   ```bash
   just k-apply path="kubernetes/manifests/<name>.yaml"
   ```
3. Check status:
   ```bash
   just k get pods -A
   just k get svc -A
   ```
