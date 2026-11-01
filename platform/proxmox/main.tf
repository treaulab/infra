resource "proxmox_download_file" "cloud_image" {
  content_type       = "import"
  datastore_id       = var.datastore_iso
  node_name          = var.proxmox_node_name
  url                = var.cloud_image_url
  file_name          = var.cloud_image_file_name
  checksum           = var.cloud_image_checksum
  checksum_algorithm = var.cloud_image_checksum != null ? "sha256" : null
}

resource "proxmox_virtual_environment_file" "cloud_init_vendor_data" {
  content_type = "snippets"
  datastore_id = var.datastore_iso
  node_name    = var.proxmox_node_name

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

resource "proxmox_virtual_environment_vm" "docker_host" {
  name        = var.vm_name
  description = "Managed by OpenTofu (platform/proxmox) - Internal Docker Host"
  tags        = ["internal", "docker", "tofu", "ubuntu-26.04"]
  node_name   = var.proxmox_node_name
  vm_id       = var.vm_id

  # Automatic startup and sequencing on host boot
  on_boot = var.vm_on_boot
  startup {
    order = var.vm_startup_order
  }

  # Modern UEFI (OVMF) boot and Q35 PCIe architecture
  bios          = "ovmf"
  machine       = "q35"
  scsi_hardware = "virtio-scsi-single"
  tablet_device = false

  efi_disk {
    datastore_id = var.datastore_vm
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
    cores = var.vm_cores
    type  = var.vm_cpu_type
    numa  = var.vm_cpu_numa
  }

  # Dynamic memory ballooning (reclaims unused RAM for the host)
  memory {
    dedicated = var.vm_memory_mb
    floating  = var.vm_memory_min_mb
  }

  disk {
    datastore_id = var.datastore_vm
    import_from  = proxmox_download_file.cloud_image.id
    interface    = "scsi0"
    iothread     = true
    discard      = "on"
    aio          = "io_uring"
    size         = var.vm_disk_size_gb
    ssd          = true
  }

  boot_order = ["scsi0"]

  network_device {
    bridge   = var.vm_network_bridge
    model    = "virtio"
    queues   = var.vm_cores
    firewall = true
    vlan_id  = var.vm_vlan_tag
  }

  operating_system {
    type = "l26"
  }

  # VirtIO RNG pass-through prevents guest entropy starvation on boot
  rng {
    source = "/dev/urandom"
  }

  # Out-of-band serial device for xterm.js / qm terminal console
  serial_device {}

  vga {
    type = "std"
  }

  initialization {
    datastore_id        = var.datastore_vm
    interface           = "scsi1"
    vendor_data_file_id = proxmox_virtual_environment_file.cloud_init_vendor_data.id

    ip_config {
      ipv4 {
        address = var.vm_ipv4_address
        gateway = var.vm_ipv4_gateway
      }
    }

    dynamic "dns" {
      for_each = var.vm_dns_servers != null ? [1] : []
      content {
        domain  = var.vm_dns_domain
        servers = var.vm_dns_servers
      }
    }

    user_account {
      username = var.admin_username
      keys     = var.admin_ssh_key != "" ? [trimspace(var.admin_ssh_key)] : []
    }
  }
}

resource "proxmox_virtual_environment_vm" "k3s_host" {
  count       = var.k3s_vm_enabled ? 1 : 0
  name        = var.k3s_vm_name
  description = "Managed by OpenTofu (platform/proxmox) - Dedicated K3s Host"
  tags        = ["internal", "k3s", "tofu", "ubuntu-26.04"]
  node_name   = var.proxmox_node_name
  vm_id       = var.k3s_vm_id

  on_boot = var.vm_on_boot
  startup {
    order = 2
  }

  bios          = "ovmf"
  machine       = "q35"
  scsi_hardware = "virtio-scsi-single"
  tablet_device = false

  efi_disk {
    datastore_id = var.datastore_vm
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
    cores = var.vm_cores
    type  = var.vm_cpu_type
    numa  = var.vm_cpu_numa
  }

  memory {
    dedicated = var.vm_memory_mb
    floating  = var.vm_memory_min_mb
  }

  disk {
    datastore_id = var.datastore_vm
    import_from  = proxmox_download_file.cloud_image.id
    interface    = "scsi0"
    iothread     = true
    discard      = "on"
    aio          = "io_uring"
    size         = var.vm_disk_size_gb
    ssd          = true
  }

  boot_order = ["scsi0"]

  network_device {
    bridge   = var.vm_network_bridge
    model    = "virtio"
    queues   = var.vm_cores
    firewall = true
    vlan_id  = var.vm_vlan_tag
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
    datastore_id        = var.datastore_vm
    interface           = "scsi1"
    vendor_data_file_id = proxmox_virtual_environment_file.cloud_init_vendor_data.id

    ip_config {
      ipv4 {
        address = var.k3s_vm_ipv4_address
        gateway = var.vm_ipv4_gateway
      }
    }

    dynamic "dns" {
      for_each = var.vm_dns_servers != null ? [1] : []
      content {
        domain  = var.vm_dns_domain
        servers = var.vm_dns_servers
      }
    }

    user_account {
      username = var.admin_username
      keys     = var.admin_ssh_key != "" ? [trimspace(var.admin_ssh_key)] : []
    }
  }
}
