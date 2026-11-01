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

output "k3s_vm_id" {
  value       = try(proxmox_virtual_environment_vm.k3s_host[0].vm_id, null)
  description = "Proxmox VM ID for K3s host"
}

output "k3s_vm_name" {
  value       = try(proxmox_virtual_environment_vm.k3s_host[0].name, null)
  description = "VM hostname for K3s host"
}
