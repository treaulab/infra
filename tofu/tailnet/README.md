# tofu/tailnet — tailnet policy + per-account keys + spoke secrets, as code

Learning root (local state). Manages the **coupling surfaces** of the
hub/spoke design; the hub workflows themselves stay plain YAML in git.
VPS infra state (`tofu/`) is never mixed with this root's state.

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
export TAILSCALE_API_KEY="$(...)"  # Tailscale admin → Settings → OAuth clients
                                   # → new client, scopes: Auth Keys (write) +
                                   # Policy (write) ONLY, shortest expiry offered.
                                   # Mint an access token from it; THAT is the value.
export TAILSCALE_TAILNET="you@example.com"
export GITHUB_TOKEN="$(gh auth token)"  # slancj admin session, repo scope.
```

Plus one trust grant (burner side, one click): spoke repo
`andrewwang2161/tailnet-shell` → Settings → Collaborators → invite
`slancj` with **Write**. Direction is explicit: spoke trusts hub-admin
for secret delivery only. Revocable there anytime (breaks future rotations
only — live runs continue until the key itself is revoked).

## 1. Order of operations (pilot: burner)

```bash
cd tofu/tailnet
tofu init

# STEP 0 — seed policy.json with the CURRENT production policy export
# (admin → Access Controls → copy whole file), merging the tag:ci-burner
# blocks, replacing every <placeholder>. NEVER apply the seed template.

# STEP 1 — adopt before managing (provider enforces this: without import,
# apply fails closed instead of overwriting production policy):
tofu import tailscale_acl.main acl

# STEP 2 — plan MUST show only your additions (tag grants/ssh/tests + 2 creates):
tofu plan

# STEP 3 — apply (mints key with tag:ci-burner, writes spoke secret):
tofu apply
chmod 600 terraform.tfstate  # state holds LIVE key material (see §4)

# STEP 4 — test from the spoke side (as burner):
# Actions → tailnet-shell → Run workflow → tailscale ssh in → node vanishes.
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
3. Sibling accounts: untouched — separate keys, separate secrets, separate
   tags. That separation is the entire point of per-account keys.

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

## 6. Account #3 pattern (no redesign)

1. Hand-create spoke repo as that account; invite hub-admin Write (revocable).
2. Add to this root: aliased provider (`provider "github" { alias="acct3",
   owner="acct3login" }`) + copied `tailscale_tailnet_key` /
   `github_actions_secret` blocks pinned to it (aliases can't `for_each` —
   explicit blocks are the honest pattern at this scale).
3. New tag (`tag:ci-acct3`) → tagOwners/grants/ssh/tests in `policy.json` →
   import already done → `plan` shows additions only → apply.

## 7. CI posture

`.github/workflows/tofu.yml` runs `init -backend=false` + `fmt -check` +
`validate` on this root (plan-only, no credentials, safe on PRs). Applies
are human, terminal, short-lived env — never CI-provisioned. Burner and
future accounts never receive IaC credentials.
