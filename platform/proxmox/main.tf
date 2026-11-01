terraform {
  required_version = ">= 1.7.0"
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.73"
    }
  }
}

# Provider credentials are read from environment variables (.envrc loaded by direnv):
# PROXMOX_VE_ENDPOINT, PROXMOX_VE_API_TOKEN, PROXMOX_VE_INSECURE
provider "proxmox" {
  ssh {
    agent    = true
    username = "root"
  }
}

# ==============================================================================
# CONFIGURATION - Edit your VMs and network settings right here:
# ==============================================================================
locals {
  # Proxmox Host Settings
  proxmox_node_name = "atlas"
  datastore_iso     = "local"
  datastore_vm      = "local-lvm"
  network_bridge    = "vmbr0"

  # Guest Network Defaults
  ipv4_gateway = "192.168.10.1"
  dns_servers  = ["192.168.10.5", "1.1.1.1"]

  # Guest Admin User
  admin_username = "treau"
  admin_ssh_key  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1DPvhdKAa5lv7h28N63he3QDzplgzmRVhqtksMHqxT trueking@latitude"

  # Cloud Image
  cloud_image_url       = "https://cloud-images.ubuntu.com/minimal/releases/resolute/release/ubuntu-26.04-minimal-cloudimg-amd64.img"
  cloud_image_file_name = "ubuntu-26.04-minimal-cloudimg-amd64.qcow2"
  cloud_image_checksum  = "6c083e6bea1573aab619c1dfa8d17bb7e3a8618fbd6cb57fa39d517b20062aa4"

  # ============================================================================
  # VM FLEET: Add, remove, or edit your virtual machines here
  # ============================================================================
  vms = {
    mercury = {
      vm_id         = 500
      ipv4_address  = "192.168.10.11/24"
      cores         = 2
      memory_mb     = 4096
      memory_min_mb = 2048
      disk_size_gb  = 32
      startup_order = 1
      tags          = ["internal", "docker", "tofu", "ubuntu-26.04"]
      description   = "Managed by OpenTofu (platform/proxmox) - Internal Docker Host"
    }
    venus = {
      vm_id         = 501
      ipv4_address  = "192.168.10.12/24"
      cores         = 2
      memory_mb     = 4096
      memory_min_mb = 2048
      disk_size_gb  = 32
      startup_order = 2
      tags          = ["internal", "k3s", "tofu", "ubuntu-26.04"]
      description   = "Managed by OpenTofu (platform/proxmox) - Dedicated K3s Host"
    }
  }
}

# ==============================================================================
# RESOURCES
# ==============================================================================

resource "proxmox_download_file" "cloud_image" {
  content_type       = "import"
  datastore_id       = local.datastore_iso
  node_name          = local.proxmox_node_name
  url                = local.cloud_image_url
  file_name          = local.cloud_image_file_name
  checksum           = local.cloud_image_checksum
  checksum_algorithm = "sha256"
}

resource "proxmox_virtual_environment_file" "cloud_init_vendor_data" {
  content_type = "snippets"
  datastore_id = local.datastore_iso
  node_name    = local.proxmox_node_name

  source_raw {
    data = <<-EOF
    #cloud-config
    package_update: true
    packages:
      - qemu-guest-agent
    runcmd:
      - systemctl enable --now qemu-guest-agent
    EOF

    file_name = "vendor-data-qemu-guest-agent.yaml"
  }
}

resource "proxmox_virtual_environment_vm" "vms" {
  for_each = local.vms

  name        = each.key
  description = each.value.description
  tags        = each.value.tags
  node_name   = local.proxmox_node_name
  vm_id       = each.value.vm_id

  on_boot = true
  startup {
    order = each.value.startup_order
  }

  bios          = "ovmf"
  machine       = "q35"
  scsi_hardware = "virtio-scsi-single"
  tablet_device = false

  efi_disk {
    datastore_id = local.datastore_vm
    type         = "4m"
  }

  agent {
    enabled = true
    trim    = true
    wait_for_ip {
      disabled = true
    }
  }

  cpu {
    cores = each.value.cores
    type  = "host"
    numa  = true
  }

  memory {
    dedicated = each.value.memory_mb
    floating  = each.value.memory_min_mb
  }

  disk {
    datastore_id = local.datastore_vm
    import_from  = proxmox_download_file.cloud_image.id
    interface    = "scsi0"
    iothread     = true
    discard      = "on"
    aio          = "io_uring"
    size         = each.value.disk_size_gb
    ssd          = true
  }

  boot_order = ["scsi0"]

  network_device {
    bridge   = local.network_bridge
    model    = "virtio"
    queues   = each.value.cores
    firewall = true
  }

  operating_system {
    type = "l26"
  }

  rng {
    source = "/dev/urandom"
  }

  serial_device {}

  vga {
    type = "std"
  }

  initialization {
    datastore_id        = local.datastore_vm
    interface           = "scsi1"
    vendor_data_file_id = proxmox_virtual_environment_file.cloud_init_vendor_data.id

    ip_config {
      ipv4 {
        address = each.value.ipv4_address
        gateway = local.ipv4_gateway
      }
    }

    dynamic "dns" {
      for_each = local.dns_servers != null ? [1] : []
      content {
        servers = local.dns_servers
      }
    }

    user_account {
      username = local.admin_username
      keys     = [trimspace(local.admin_ssh_key)]
    }
  }
}

# ==============================================================================
# OUTPUTS
# ==============================================================================
output "vms" {
  value = {
    for name, vm in proxmox_virtual_environment_vm.vms : name => {
      vm_id          = vm.vm_id
      name           = vm.name
      ipv4_addresses = vm.ipv4_addresses
      mac_addresses  = vm.mac_addresses
    }
  }
  description = "Provisioned Proxmox VMs"
}
