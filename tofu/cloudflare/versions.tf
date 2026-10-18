terraform {
  required_version = ">= 1.7.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
  # v1: local state. No secret material (DNS records + zone lookups), but the
  # zone is a critical surface — state stays gitignored (*.tfstate) by rule.
  # Migrate to azurerm backend alongside the other roots if ever centralized:
  # backend "azurerm" {
  #   resource_group_name  = "tfstate-rg"
  #   storage_account_name = "treaulabtfstate"
  #   container_name       = "tfstate"
  #   key                  = "cloudflare-prod.tfstate"
  # }
}
