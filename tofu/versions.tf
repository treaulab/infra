terraform {
  required_version = ">= 1.7.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # v1: local state. Migrate to azurerm backend after first apply:
  # backend "azurerm" {
  #   resource_group_name  = "tfstate-rg"
  #   storage_account_name = "treaulabtfstate"
  #   container_name       = "tfstate"
  #   key                  = "infra-prod.tfstate"
  # }
}
