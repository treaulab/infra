# tofu/github — repo governance as code (P0: branch protection)

Learning root, local state, **no secret material** (branch policy only —
safe to learn on, safe in state). Applies are human with a short-lived
admin PAT; CI is plan/validate-only (see `.github/workflows/tofu.yml`).

```
GITHUB_TOKEN (admin, short-lived, env only)
  └─► tofu/github ─► branch protection on treaulab/infra#main
```

## What this changes (read before apply)

* Non-admin Write holders (e.g. burner, if ever granted): **cannot push
  to main directly anymore** — PR + 1 approval (you) + resolved threads.
  Force-pushes and branch deletion banned for everyone but admins.
* You (admin) with `enforce_admins = false` (default): **nothing changes**
  — direct pushes keep working. This is deliberate: the threat is
  non-admin Write, not you. The rule still binds every other writer.
* Flip day: set `enforce_admins = true` (+ `-var` or tfvars) when you want
  full PR-only discipline including yourself. From that apply on,
  `git push main` gets rejected for you too — all changes via PR.

## Use

```bash
export GITHUB_TOKEN="$(gh auth token)"   # slancj admin session
cd tofu/github
tofu init
tofu plan    # expect: 1 create (github_branch_protection.main), nothing else
tofu apply
```

Verify: `gh api repos/treaulab/infra/branches/main/protection --jq .required_pull_request_reviews.dismiss_stale_reviews`
→ `true`. (Before apply the same call 404s — that 404 is the finding.)

Tightening path (stepwise, each its own apply):
1. `required_status_checks { contexts = [...] }` — only after `deploy`
   goes green and required workflows actually run on PRs (requiring a
   red/tag-only check bricks merges; verified red today).
2. `enforce_admins = true` — full PR-only, including you.
3. `required_linear_history` / signed commits — hygiene, opt-in.

Rollback: `tofu destroy` (policy only — nothing lost). State is
low-sensitivity here but stays gitignored by rule, same as every root.
