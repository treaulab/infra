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
  # v1: local state (learning root). State holds LIVE key material
  # (tailscale_tailnet_key.key, spoke secret value) — chmod 600, never copy
  # it anywhere, never commit it (*.tfstate is gitignored). Migrate to an
  # encrypted azurerm backend before any production use (see README.md).
  # backend "azurerm" {
  #   resource_group_name  = "tfstate-rg"
  #   storage_account_name = "treaulabtfstate"
  #   container_name       = "tfstate"
  #   key                  = "tailnet-prod.tfstate"
  # }
}
