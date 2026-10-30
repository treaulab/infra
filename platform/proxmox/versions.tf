terraform {
  required_version = ">= 1.7.0"
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.73"
    }
  }
  # v1: local state. State stays gitignored (*.tfstate) by rule.
  # Migrate to remote backend alongside the other roots if ever centralized:
  # backend "azurerm" {
  #   resource_group_name  = "tfstate-rg"
  #   storage_account_name = "treaulabtfstate"
  #   container_name       = "tfstate"
  #   key                  = "proxmox-prod.tfstate"
  # }
}
