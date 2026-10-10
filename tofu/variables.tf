variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
  sensitive   = true
}

variable "resource_group_name" {
  description = "Existing or new RG (see create_resource_group)"
  type        = string
  default     = "treaulab-prod-rg"
}

variable "location" {
  description = "Azure region, e.g. westeurope"
  type        = string
  default     = "westeurope"
}

variable "create_resource_group" {
  description = "true = create RG, false = import existing via data source"
  type        = bool
  default     = false
}

variable "vnet_name" {
  type    = string
  default = "treaulab-prod-vnet"
}

variable "vnet_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "subnet_name" {
  type    = string
  default = "main"
}

variable "subnet_cidr" {
  type    = string
  default = "10.0.1.0/24"
}

variable "vm_name" {
  type    = string
  default = "treaulab-prod-vps"
}

variable "vm_size" {
  description = "Single VPS size"
  type        = string
  default     = "Standard_B2s"
}

variable "admin_username" {
  type    = string
  default = "azureuser"
}

variable "admin_ssh_key" {
  description = "Public SSH key for admin user"
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "Lock down 22 to your IP. * = open (not recommended)"
  type        = string
  default     = "*"
}

variable "tags" {
  type = map(string)
  default = {
    managed-by = "tofu"
    project    = "treaulab-infra"
    env        = "prod"
  }
}
