terraform {
  required_version = ">= 1.7.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.11"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Provider credentials can be passed via environment variables (ARM_SUBSCRIPTION_ID, ARM_CLIENT_ID, etc.)
# or configured below in locals.
provider "azurerm" {
  features {}
  subscription_id = local.subscription_id != "" ? local.subscription_id : null
}

# ==============================================================================
# CONFIGURATION
# ==============================================================================
locals {
  # Azure Subscription ID (leave empty to use ARM_SUBSCRIPTION_ID environment variable)
  subscription_id = ""

  # Resource Group
  resource_group_name   = "treaulab-prod-rg"
  azure_region          = "westeurope"
  create_resource_group = false

  # Networking
  vnet_name   = "treaulab-prod-vnet"
  vnet_cidr   = "10.0.0.0/16"
  subnet_name = "main"
  subnet_cidr = "10.0.1.0/24"

  # VM Configuration
  vm_name        = "treaulab-prod-vps"
  vm_size        = "Standard_B2s"
  admin_username = "azureuser"
  admin_ssh_key  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1DPvhdKAa5lv7h28N63he3QDzplgzmRVhqtksMHqxT trueking@latitude"

  # Security Rules: Lock down port 22 to specific CIDR (e.g., "203.0.113.10/32") or "*" for open
  allowed_ssh_cidr = "*"

  tags = {
    managed-by = "tofu"
    project    = "treaulab-infra"
    env        = "prod"
  }

  # Resolved Resource Group attributes
  rg_name  = local.create_resource_group ? azurerm_resource_group.main[0].name : data.azurerm_resource_group.existing[0].name
  location = local.create_resource_group ? azurerm_resource_group.main[0].location : data.azurerm_resource_group.existing[0].location
}

# ==============================================================================
# RESOURCES
# ==============================================================================

# Single Azure VPS networking. Web-only (80/443 + SSH).
# Import existing resources instead of recreating:
#   tofu import azurerm_resource_group.main /subscriptions/<sub>/resourceGroups/<rg>
#   tofu import azurerm_virtual_network.main <id>  (see outputs after plan)

data "azurerm_resource_group" "existing" {
  count = local.create_resource_group ? 0 : 1
  name  = local.resource_group_name
}

resource "azurerm_resource_group" "main" {
  count    = local.create_resource_group ? 1 : 0
  name     = local.resource_group_name
  location = local.azure_region
  tags     = local.tags
}

resource "azurerm_virtual_network" "main" {
  name                = local.vnet_name
  resource_group_name = local.rg_name
  location            = local.location
  address_space       = [local.vnet_cidr]
  tags                = local.tags
}

resource "azurerm_subnet" "main" {
  name                 = local.subnet_name
  resource_group_name  = local.rg_name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [local.subnet_cidr]
}

resource "azurerm_network_security_group" "main" {
  name                = "${local.vm_name}-nsg"
  resource_group_name = local.rg_name
  location            = local.location
  tags                = local.tags

  security_rule {
    name                       = "ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = local.allowed_ssh_cidr
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "http"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "https"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_public_ip" "main" {
  name                = "${local.vm_name}-pip"
  resource_group_name = local.rg_name
  location            = local.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_network_interface" "main" {
  name                = "${local.vm_name}-nic"
  resource_group_name = local.rg_name
  location            = local.location
  tags                = local.tags

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.main.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.main.id
  }
}

resource "azurerm_network_interface_security_group_association" "main" {
  network_interface_id      = azurerm_network_interface.main.id
  network_security_group_id = azurerm_network_security_group.main.id
}

resource "azurerm_linux_virtual_machine" "main" {
  name                            = local.vm_name
  resource_group_name             = local.rg_name
  location                        = local.location
  size                            = local.vm_size
  admin_username                  = local.admin_username
  disable_password_authentication = true
  tags                            = local.tags

  network_interface_ids = [azurerm_network_interface.main.id]

  admin_ssh_key {
    username   = local.admin_username
    public_key = local.admin_ssh_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-noble"
    sku       = "24_04-lts-gen2"
    version   = "latest"
  }
}

# ==============================================================================
# OUTPUTS
# ==============================================================================

output "public_ip" {
  value       = azurerm_public_ip.main.ip_address
  description = "Point <domain> A-record here"
}

output "resource_group" {
  value = local.rg_name
}

output "nsg_id" {
  value = azurerm_network_security_group.main.id
}
