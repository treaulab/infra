# main IS protected (applied 2026-10-14; local state in this root, plan is
# clean). Verify with an ADMIN token: GitHub returns 404 on the protection
# endpoint for non-admins — how "unprotected" was misread once.
#
# This rule forces everyone EXCEPT admins through PRs with approval +
# resolved threads, and bans force-pushes/deletions.
#
# Status check "check" (from .github/workflows/check.yml) runs on all PRs
# without path filters, so requiring it does not stall unrelated merges.
#
# Rollback: tofu destroy removes the rule cleanly (protection is policy,
# not data — nothing to lose). On a fresh clone (no state), import before
# apply: tofu import github_branch_protection.main infra:main

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

  required_status_checks {
    strict   = false
    contexts = ["check"]
  }
}
