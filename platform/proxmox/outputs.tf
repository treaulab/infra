output "vm_id" {
  value       = proxmox_virtual_environment_vm.docker_host.vm_id
  description = "Proxmox VM ID"
}

output "vm_name" {
  value       = proxmox_virtual_environment_vm.docker_host.name
  description = "VM hostname"
}

output "ipv4_addresses" {
  value       = proxmox_virtual_environment_vm.docker_host.ipv4_addresses
  description = "IPv4 addresses reported by the QEMU guest agent"
}

output "mac_addresses" {
  value       = proxmox_virtual_environment_vm.docker_host.mac_addresses
  description = "MAC addresses assigned to the VM network interfaces"
}
