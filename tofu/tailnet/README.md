# tofu/tailnet — tailnet policy as code (OIDC preferred, keys legacy)

Learning root (local state). Manages the **coupling surfaces** of the
hub/spoke design; the hub workflows themselves stay plain YAML in git.
VPS infra state (`tofu/`) is never mixed with this root's state.

Preferred (no ceremony): OIDC workload identity federation — one manual
Trust-credentials setup, spoke VARIABLES `TS_OIDC_CLIENT_ID`/`TS_AUDIENCE`,
hub `tailnet-runner.yml` connects via `tailscale/github-action` with
`id-token: write`. No keys, no `github_actions_secret`, no grant windows.
This root then manages ONLY `tailscale_acl` (policy.json).

Legacy (30-day rotation): `tailscale_tailnet_key` + `github_actions_secret`
below. Keep for fallback until OIDC is proven.

```
OAuth client (manual, scoped, expiring)
  └─ TAILSCALE_API_KEY ─┐
admin PAT (manual, short-lived) → GITHUB_TOKEN ─┐
                                                 ▼
                        ┌──────── tofu/tailnet ─────────────────┐
                        │ tailscale_acl (ONE doc for the tailnet)│
                        │ tailscale_tailnet_key.spoke ─┐         │
                        │ github_actions_secret ───────┴─ value  │
                        └────────────────────────────────────────┘
                                   │                │
                          spoke repo secret   tailnet policy
                          (burner runs)       (tags + SSH)
```

## 0. Bootstrap ceremony (once, human, ~10 min)

Nothing here works without two short-lived credentials in env (never in
files — no tfvars committed, `*.tfvars` gitignored):

```bash
export TAILSCALE_OAUTH_CLIENT_ID="k12345..."      # your OAuth client ID
export TAILSCALE_OAUTH_CLIENT_SECRET="tskey-client-..."  # your client secret
export TAILSCALE_TAILNET="you@example.com"
export GITHUB_TOKEN="$(gh auth token)"  # slancj admin session, repo scope.
```
Client prerequisites (set once in Tailscale admin): scopes `auth_keys` +
`policy_file` + `devices:core:read` + `devices:posture_attributes`, tags
including `tag:ci-ephemeral`, shortest expiry. Fallback instead of the
pair: a pre-minted access token as `TAILSCALE_API_KEY` (one path, not both).

Plus one trust grant (burner side, one click per ceremony): spoke repo
`andrewwang2161/dotfiles` (PUBLIC, plain dotfiles + README + caller) →
Settings → Collaborators → invite `slancj` with **Write** for the grant
window only, then **revoke immediately after apply** (re-grant ~30s per
future rotation). Direction is explicit: spoke trusts hub-admin for secret
delivery during ceremonies. No standing cross-account edge, ever. Strict
alternative (zero grants): per-ceremony burner PAT in env while tofu mints
via admin OAuth — same outcome, more labor (see §6).

## 1. Order of operations (pilot: burner)

```bash
cd tofu/tailnet
tofu init

# STEP 0 — seed policy.json with the CURRENT production policy export
# (admin → Access Controls → copy whole file), merging the tag:ci-ephemeral
# blocks, replacing every <placeholder>. NEVER apply the seed template.

# STEP 1 — adopt before managing (provider enforces this: without import,
# apply fails closed instead of overwriting production policy):
tofu import tailscale_acl.main acl

# STEP 2 — plan MUST show only your additions (tag grants/ssh/tests + 2 creates):
tofu plan

# STEP 3 — apply (mints key(s), writes spoke secret(s) — values never
# rendered, never pasted). Revoke the Write grant immediately after.
tofu apply
chmod 600 terraform.tfstate  # state holds LIVE key material (see §4)

# STEP 4 — test from the spoke side (as burner):
# Actions → tailnet-runner → Run workflow (tenant=t1) → tailscale ssh in.
```

## 2. Rotation (routine, no drama)

Keys are short-lived by design (`key_expiry_seconds`, default 30d;
`recreate_if_invalid = "always"` self-heals expired keys):

```bash
tofu taint tailscale_tailnet_key.spoke && tofu apply
# → new key minted AND spoke secret updated in the same apply.
# Watch key_expires_at output; rotate a week before it.
```

## 3. Revocation (incident — admin click FIRST, IaC second)

1. Tailscale admin → revoke the key **now** (fastest kill; in-flight runs die).
2. Then reconcile: `tofu taint ... && tofu apply` (fresh key + secret), or
   remove the resource + apply if the account is being offboarded (also
   delete its spoke repo + tag blocks from policy.json in a second apply).
3. Sibling tenants: untouched — separate keys, separate secrets, separate
   tags. That separation is the entire point of per-tenant keys.

## 4. State hygiene (local-state learning root — read twice)

`terraform.tfstate` here contains the **live key** (`tailnet_key.key`,
sensitive-flagged but present) and the spoke secret value. Rules:
`chmod 600`, no copies/backups/screenshots, never commit (gitignored),
never print (`outputs.tf` exposes metadata only — `key_id`,
`key_expires_at` — by design). End of learning: `tofu destroy`
(keys revoked, secrets removed from spokes, policy left in place — note
`reset_acl_on_destroy` is deliberately NOT set so destroy can't nuke the
tailnet policy) or migrate below.

## 5. Backend migration (before ANY production use)

Uncomment the `azurerm` backend in `versions.tf`, create the storage
resources (encrypted at rest, private container, locked), `tofu init -migrate-state`,
verify `plan` is empty, then delete local state with `shred -u`.

## 6. Tenant pattern (one repo, N keys — no fleet, no new providers)

Tenants are keys + secrets + tags, NOT accounts: same burner repo, same
github provider, one `tailscale_tailnet_key` + one
`github_actions_secret` per tenant (distinct `secret_name`, distinct tag —
see `tenants.tf.example`). New tag (`tag:ci-t2`) → tagOwners/grants/ssh/
tests in `policy.json` → `plan` shows additions only → grant window →
apply → revoke. Pilot `spoke` blocks migrate to `t1` naming when the spoke
repo exists (explicit state mv, human decision — not done preemptively).

Strict variant (zero grants, zero foreign-authored commits): per-ceremony
burner PAT (`GH_BURNER_TOKEN`, that repo only, days-long expiry, revoke
after) as the github provider token for the apply. Same resources, no
grant window, more labor per rotation.

## 7. CI posture

`.github/workflows/tofu.yml` runs `init -backend=false` + `fmt -check` +
`validate` on this root (plan-only, no credentials, safe on PRs). Applies
are human, terminal, short-lived env — never CI-provisioned. Burner and
future accounts never receive IaC credentials.
