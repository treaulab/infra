terraform {
  required_version = ">= 1.7.0"
  required_providers {
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.29"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

# Both providers authenticate via ENVIRONMENT ONLY — no tokens in code, tfvars, or state inputs:
# Tailscale: TAILSCALE_OAUTH_CLIENT_ID, TAILSCALE_OAUTH_CLIENT_SECRET, TAILSCALE_TAILNET
# GitHub: GITHUB_TOKEN
provider "tailscale" {}

provider "github" {
  owner = local.spoke_owner
}

# ==============================================================================
# CONFIGURATION
# ==============================================================================
locals {
  spoke_owner        = "andrewwang2161"
  spoke_repo         = "dotfiles"
  spoke_secret_name  = "TS_AUTHKEY_EPHEMERAL"
  key_tag            = "tag:ci-ephemeral"
  key_expiry_seconds = 2592000 # 30 days
  key_description    = "tailnet-runner hourly runner burner"
  policy_file        = "policy.json"
}

# ==============================================================================
# RESOURCES
# ==============================================================================

# Tailnet ACL policy document
resource "tailscale_acl" "main" {
  acl = file("${path.module}/${local.policy_file}")
}

# Ephemeral pre-auth key for runner nodes
resource "tailscale_tailnet_key" "spoke" {
  reusable            = true
  ephemeral           = true
  preauthorized       = true
  expiry              = local.key_expiry_seconds
  tags                = [local.key_tag]
  description         = local.key_description
  recreate_if_invalid = "always"
}

# Spoke-side delivery: key landed in repository secret
resource "github_actions_secret" "spoke_key" {
  repository  = local.spoke_repo
  secret_name = local.spoke_secret_name
  value       = tailscale_tailnet_key.spoke.key
}

# ==============================================================================
# OUTPUTS
# ==============================================================================

output "key_id" {
  description = "Tailscale ID of the spoke key."
  value       = tailscale_tailnet_key.spoke.id
}

output "key_expires_at" {
  description = "RFC3339 expiry of the spoke key."
  value       = tailscale_tailnet_key.spoke.expires_at
}

output "spoke_secret" {
  description = "Where the key was delivered (owner/repo:secret)."
  value       = "${local.spoke_owner}/${local.spoke_repo}:${local.spoke_secret_name}"
}
