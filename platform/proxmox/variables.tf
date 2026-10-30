variable "proxmox_endpoint" {
  description = "Proxmox VE API URL (e.g. https://proxmox.home.lan:8006/)"
  type        = string
}

variable "proxmox_api_token" {
  description = "Proxmox API token in format USER@REALM!TOKENID=UUID"
  type        = string
  sensitive   = true
}

variable "proxmox_insecure" {
  description = "Skip TLS certificate verification for self-signed Proxmox certificates"
  type        = bool
  default     = true
}

variable "proxmox_node_name" {
  description = "Target Proxmox node name"
  type        = string
  default     = "pve"
}

variable "datastore_iso" {
  description = "Datastore name storing cloud-init images/ISOs (typically 'local')"
  type        = string
  default     = "local"
}

variable "datastore_vm" {
  description = "Datastore name storing VM root disks (typically 'local-lvm' or 'local-zfs')"
  type        = string
  default     = "local-lvm"
}

variable "cloud_image_url" {
  description = "Download URL for the Ubuntu 26.04 LTS ('Resolute Raccoon') minimal cloud-init image"
  type        = string
  default     = "https://cloud-images.ubuntu.com/minimal/releases/resolute/release/ubuntu-26.04-minimal-cloudimg-amd64.img"
}

variable "cloud_image_file_name" {
  description = "File name for the downloaded cloud image in the datastore"
  type        = string
  default     = "ubuntu-26.04-minimal-cloudimg-amd64.img"
}

variable "cloud_image_checksum" {
  description = "SHA256 checksum for the Ubuntu 26.04 LTS minimal cloud image"
  type        = string
  default     = "6c083e6bea1573aab619c1dfa8d17bb7e3a8618fbd6cb57fa39d517b20062aa4"
}

variable "vm_id" {
  description = "Explicit VM ID (optional; Proxmox assigns the next free ID if null)"
  type        = number
  default     = null
}

variable "vm_name" {
  description = "Hostname and display name for the VM"
  type        = string
  default     = "treaulab-homelab-docker"
}

variable "vm_on_boot" {
  description = "Automatically start the VM when the Proxmox host boots"
  type        = bool
  default     = true
}

variable "vm_startup_order" {
  description = "Startup priority sequence for the VM on host boot"
  type        = number
  default     = 1
}

variable "vm_cores" {
  description = "Number of CPU cores"
  type        = number
  default     = 2
}

variable "vm_cpu_type" {
  description = "Emulated CPU type ('host' exposes all host CPU flags like AES-NI and AVX2)"
  type        = string
  default     = "host"
}

variable "vm_cpu_numa" {
  description = "Enable NUMA architecture inside the guest VM for multi-core memory performance"
  type        = bool
  default     = true
}

variable "vm_memory_mb" {
  description = "Maximum dedicated RAM in megabytes"
  type        = number
  default     = 4096
}

variable "vm_memory_min_mb" {
  description = "Minimum floating RAM in megabytes for VirtIO dynamic ballooning"
  type        = number
  default     = 2048
}

variable "vm_disk_size_gb" {
  description = "Root disk size in gigabytes"
  type        = number
  default     = 32
}

variable "vm_network_bridge" {
  description = "Linux bridge on the Proxmox host"
  type        = string
  default     = "vmbr0"
}

variable "vm_vlan_tag" {
  description = "Optional 802.1Q VLAN tag for the VM network interface"
  type        = number
  default     = null
}

variable "vm_ipv4_address" {
  description = "IPv4 address in CIDR notation (e.g. 192.168.1.50/24) or 'dhcp'"
  type        = string
  default     = "dhcp"
}

variable "vm_ipv4_gateway" {
  description = "IPv4 default gateway (required if static IPv4 is used)"
  type        = string
  default     = null
}

variable "vm_dns_servers" {
  description = "Optional custom DNS server IPs for guest cloud-init resolution"
  type        = list(string)
  default     = null
}

variable "vm_dns_domain" {
  description = "Optional search domain for guest cloud-init resolution"
  type        = string
  default     = null
}

variable "admin_username" {
  description = "Default administrative username created by cloud-init"
  type        = string
  default     = "treau"
}

variable "admin_ssh_key" {
  description = "Authorized SSH public key for the admin user"
  type        = string
  default     = ""
}
