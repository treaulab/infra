variable "proxmox_node_name" {
  description = "Target Proxmox node name"
  type        = string
  default     = "atlas"
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
  description = "File name for the downloaded cloud image in the datastore (.raw, .qcow2, or .vmdk for import)"
  type        = string
  default     = "ubuntu-26.04-minimal-cloudimg-amd64.qcow2"
}

variable "cloud_image_checksum" {
  description = "SHA256 checksum for the Ubuntu 26.04 LTS minimal cloud image"
  type        = string
  default     = "6c083e6bea1573aab619c1dfa8d17bb7e3a8618fbd6cb57fa39d517b20062aa4"
}

# --- Shared VM Defaults ---

variable "vm_on_boot" {
  description = "Automatically start VMs when the Proxmox host boots"
  type        = bool
  default     = true
}

variable "vm_cpu_type" {
  description = "Emulated CPU type ('host' exposes all host CPU flags like AES-NI and AVX2)"
  type        = string
  default     = "host"
}

variable "vm_cpu_numa" {
  description = "Enable NUMA architecture inside guest VMs for multi-core memory performance"
  type        = bool
  default     = true
}

variable "vm_network_bridge" {
  description = "Linux bridge on the Proxmox host"
  type        = string
  default     = "vmbr0"
}

variable "vm_vlan_tag" {
  description = "Optional 802.1Q VLAN tag for VM network interfaces"
  type        = number
  default     = null
}

variable "vm_ipv4_gateway" {
  description = "Default IPv4 gateway for guest VMs"
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

# --- Declarative VM Fleet Map ---

variable "vms" {
  description = "Map of Proxmox VMs to provision"
  type = map(object({
    vm_id         = number
    cores         = optional(number, 2)
    memory_mb     = optional(number, 4096)
    memory_min_mb = optional(number, 2048)
    disk_size_gb  = optional(number, 32)
    ipv4_address  = string
    description   = optional(string)
    tags          = optional(list(string))
    startup_order = optional(number, 1)
  }))
  default = {
    mercury = {
      vm_id        = 100
      ipv4_address = "192.168.10.50/24"
    }
  }
}
