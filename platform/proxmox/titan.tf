# ==============================================================================
# DECLARATIVE INSTALLATION MEDIA (pve: 192.168.10.9)
# ==============================================================================

# Genuine Microsoft Windows 11 IoT Enterprise LTSC 2024 (Build 26100.1742 MSDN)
resource "proxmox_download_file" "win11_ltsc_iso" {
  provider           = proxmox.pve
  content_type       = "iso"
  datastore_id       = "local"
  node_name          = "pve"
  url                = "https://archive.org/download/en-us_windows_11_iot_enterprise_ltsc_2024_x64_dvd_f6b14814/en-us_windows_11_iot_enterprise_ltsc_2024_x64_dvd_f6b14814.iso"
  file_name          = "win11-ltsc.iso"
  checksum           = "4f59662a96fc1da48c1b415d6c369d08af55ddd64e8f1c84e0166d9e50405d7a"
  checksum_algorithm = "sha256"
  upload_timeout     = 3600
}

# Verified Stable VirtIO Drivers (Release 0.1.271-1)
resource "proxmox_download_file" "virtio_win_iso" {
  provider           = proxmox.pve
  content_type       = "iso"
  datastore_id       = "local"
  node_name          = "pve"
  url                = "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.271-1/virtio-win-0.1.271.iso"
  file_name          = "virtio-win-0.1.271.iso"
  checksum           = "bbe6166ad86a490caefad438fef8aa494926cb0a1b37fa1212925cfd81656429"
  checksum_algorithm = "sha256"
  upload_timeout     = 1800
}

# ==============================================================================
# WINDOWS 11 ENTERPRISE LTSC WORKSTATION: titan (VM 300)
# ==============================================================================
resource "proxmox_virtual_environment_vm" "titan" {
  provider    = proxmox.pve
  node_name   = "pve"
  vm_id       = 300
  name        = "titan"
  description = "Managed by OpenTofu (platform/proxmox) - Windows 11 Enterprise LTSC 2024 (192.168.10.31)"
  tags        = ["windows", "ltsc", "titan", "tofu"]

  # Post-install: VM powered off in pristine state
  started = false

  machine = "q35"
  bios    = "ovmf"

  scsi_hardware = "virtio-scsi-single"

  agent {
    enabled = true
    trim    = true
    wait_for_ip {
      disabled = true
    }
  }

  cpu {
    cores = 4
    type  = "host"
    numa  = true
  }

  memory {
    dedicated = 4096
    floating  = 0
  }

  efi_disk {
    datastore_id      = "local-zfs"
    file_format       = "raw"
    type              = "4m"
    pre_enrolled_keys = true
  }

  tpm_state {
    datastore_id = "local-zfs"
    version      = "v2.0"
  }

  disk {
    datastore_id = "local-zfs"
    interface    = "scsi0"
    file_format  = "raw"
    iothread     = true
    discard      = "on"
    aio          = "threads"
    size         = 64
    ssd          = true
  }

  # Post-install: CDROM ejected and boot locked to scsi0
  cdrom {
    interface = "ide2"
    file_id   = "none"
  }

  boot_order = ["scsi0"]

  network_device {
    bridge      = "vmbr0"
    model       = "virtio"
    mac_address = "B4:45:06:51:D4:89"
    firewall    = false
  }

  operating_system {
    type = "win11"
  }

  vga {
    type = "std"
  }
}
