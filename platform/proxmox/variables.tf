variable "proxmox_pve_endpoint" {
  type        = string
  description = "Proxmox API endpoint for independent pve node"
  default     = "https://192.168.10.9:8006/"
}

variable "proxmox_pve_api_token" {
  type        = string
  description = "Proxmox API token for independent pve node"
  sensitive   = true
  default     = null
}
