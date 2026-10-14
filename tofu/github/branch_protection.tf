# P0 containment: main is unprotected today (verified via API: 404 on the
# protection endpoint), so any Write holder can push straight to main and
# trip deploy paths. This rule forces everyone EXCEPT admins through PRs
# with approval + resolved threads, and bans force-pushes/deletions.
#
# Deliberately NOT required (yet): status checks (deploy is red without
# secrets and agent-bin runs on tags only — requiring either would brick
# merges; add contexts once those run green on PRs), signed commits,
# linear history, code-owner reviews. Tighten stepwise (see README.md).
#
# Rollback: tofu destroy removes the rule cleanly (protection is policy,
# not data — nothing to lose). No import needed: no rule exists today.

resource "github_branch_protection" "main" {
  repository_id = var.repository
  pattern       = var.pattern

  enforce_admins                  = var.enforce_admins
  require_conversation_resolution = true

  allows_deletions    = false
  allows_force_pushes = false

  required_pull_request_reviews {
    dismiss_stale_reviews           = true
    required_approving_review_count = var.required_approvals
  }
}
