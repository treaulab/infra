# ==============================================================================
# OpenWrt Gateway VM (DPI Circumvention & Forward Proxy)
# IP: 192.168.10.2/24 | Gateway: 192.168.10.1 | Upstream DNS: 192.168.10.5
# ==============================================================================

locals {
  openwrt_vm_id     = 200
  openwrt_ip        = "192.168.10.2"
  openwrt_image_url = "https://downloads.openwrt.org/releases/25.12.6/targets/x86/64/openwrt-25.12.6-x86-64-generic-ext4-combined.img.gz"
  openwrt_file_name = "openwrt-25.12.6-x86-64-generic-ext4-combined.img"
}

resource "proxmox_download_file" "openwrt_image" {
  content_type            = "import"
  datastore_id            = local.datastore_iso
  node_name               = local.proxmox_node_name
  url                     = local.openwrt_image_url
  file_name               = local.openwrt_file_name
  decompression_algorithm = "gz"
}

resource "proxmox_virtual_environment_vm" "openwrt" {
  name        = "openwrt"
  description = "Managed by OpenTofu (platform/proxmox) - One-Armed Transparent DPI Bypass Gateway (${local.openwrt_ip})"
  tags        = ["gateway", "openwrt", "tofu"]
  node_name   = local.proxmox_node_name
  vm_id       = local.openwrt_vm_id

  on_boot = true
  startup {
    order = 1
  }

  bios          = "seabios"
  machine       = "q35"
  scsi_hardware = "virtio-scsi-single"
  tablet_device = false

  cpu {
    cores = 2
    type  = "host"
  }

  memory {
    dedicated = 512
  }

  disk {
    datastore_id = local.datastore_vm
    import_from  = proxmox_download_file.openwrt_image.id
    interface    = "scsi0"
    iothread     = true
    discard      = "on"
    aio          = "io_uring"
    size         = 2
    ssd          = true
  }

  boot_order = ["scsi0"]

  network_device {
    bridge   = local.network_bridge
    model    = "virtio"
    firewall = false
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
}

output "openwrt_vm" {
  value = {
    vm_id        = proxmox_virtual_environment_vm.openwrt.vm_id
    name         = proxmox_virtual_environment_vm.openwrt.name
    ipv4_address = local.openwrt_ip
    mac_address  = proxmox_virtual_environment_vm.openwrt.network_device[0].mac_address
  }
  description = "OpenWrt Gateway Virtual Machine"
}
