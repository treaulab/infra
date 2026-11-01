terraform {
  required_version = ">= 1.7.0"
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

# Provider credentials are read from environment variable: GITHUB_TOKEN
# Applies are human, terminal — never CI.
provider "github" {
  owner = local.owner
}

# ==============================================================================
# CONFIGURATION
# ==============================================================================
locals {
  owner              = "treaulab"
  repository         = "infra"
  pattern            = "main"
  required_approvals = 1
  enforce_admins     = false # Set to true when ready for full PR-only discipline
}

# ==============================================================================
# RESOURCES
# ==============================================================================

# main branch protection rule:
# Forces non-admins through PRs with approval + resolved threads, and bans force-pushes/deletions.
# Status check "check" (from .github/workflows/check.yml) runs on all PRs.
resource "github_branch_protection" "main" {
  repository_id = local.repository
  pattern       = local.pattern

  enforce_admins                  = local.enforce_admins
  require_conversation_resolution = true

  allows_deletions    = false
  allows_force_pushes = false

  required_pull_request_reviews {
    dismiss_stale_reviews           = true
    required_approving_review_count = local.required_approvals
  }

  required_status_checks {
    strict   = false
    contexts = ["check"]
  }
}
