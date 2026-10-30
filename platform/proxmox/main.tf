resource "proxmox_download_file" "cloud_image" {
  content_type       = "iso"
  datastore_id       = var.datastore_iso
  node_name          = var.proxmox_node_name
  url                = var.cloud_image_url
  file_name          = var.cloud_image_file_name
  checksum           = var.cloud_image_checksum
  checksum_algorithm = var.cloud_image_checksum != null ? "sha256" : null
}

resource "proxmox_virtual_environment_vm" "docker_host" {
  name        = var.vm_name
  description = "Managed by OpenTofu (platform/proxmox) - Homelab Docker Host"
  tags        = ["homelab", "docker", "tofu"]
  node_name   = var.proxmox_node_name
  vm_id       = var.vm_id

  # Modern Q35 PCIe chipset & dedicated virtio-scsi controller per disk
  machine       = "q35"
  scsi_hardware = "virtio-scsi-single"

  agent {
    enabled = true
    trim    = true
  }

  cpu {
    cores        = var.vm_cores
    type         = var.vm_cpu_type
    architecture = "x86_64"
  }

  memory {
    dedicated = var.vm_memory_mb
  }

  disk {
    datastore_id = var.datastore_vm
    file_id      = proxmox_download_file.cloud_image.id
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

  initialization {
    ip_config {
      ipv4 {
        address = var.vm_ipv4_address
        gateway = var.vm_ipv4_gateway
      }
    }

    user_account {
      username = var.admin_username
      keys     = var.admin_ssh_key != "" ? [trimspace(var.admin_ssh_key)] : []
    }
  }
}
