# platform/github — repo governance as code (P0: branch protection)

Learning root, local state, **no secret material** (branch policy only —
safe to learn on, safe in state). Applies are human with a short-lived
admin PAT; CI is validate-only (see `.github/workflows/tofu.yml`).

**Status: applied 2026-10-14 — live on `treaulab/infra#main`, `tofu plan` clean.**

```
GITHUB_TOKEN (admin, short-lived, env only)
  └─► platform/github ─► branch protection on treaulab/infra#main
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
cd platform/github
tofu init
tofu plan    # expect: "No changes" (rule applied 2026-10-14)
tofu apply
```

Fresh clone / lost state: import before apply —
`tofu import github_branch_protection.main infra:main` (an apply against
missing state would try to recreate a rule that already exists).

Verify (admin token — non-admins get 404 here whether or not the rule
exists): `gh api repos/treaulab/infra/branches/main/protection --jq .required_pull_request_reviews.dismiss_stale_reviews`
→ `true`.

Tightening path (stepwise, each its own apply):
1. `required_status_checks { contexts = [...] }` — only once a check runs
   on every PR: `ci.yml` is path-filtered and not yet on main, so land it
   there and drop the filter first — requiring a check that never reports
   bricks merges.
2. `enforce_admins = true` — full PR-only, including you.
3. `required_linear_history` / signed commits — hygiene, opt-in.

Rollback: `tofu destroy` (policy only — nothing lost). State is
low-sensitivity here but stays gitignored by rule, same as every root.
