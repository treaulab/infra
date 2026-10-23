terraform {
  required_version = ">= 1.7.0"
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
  # v1: local state. No secret material in this root (branch policy only),
  # so state here is low-sensitivity — still gitignored (*.tfstate) by rule.
  # Migrate to azurerm backend alongside platform/tailscale if ever centralized:
  # backend "azurerm" {
  #   resource_group_name  = "tfstate-rg"
  #   storage_account_name = "treaulabtfstate"
  #   container_name       = "tfstate"
  #   key                  = "github-prod.tfstate"
  # }
}
