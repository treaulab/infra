output "vms" {
  value = {
    for name, vm in proxmox_virtual_environment_vm.vms : name => {
      vm_id          = vm.vm_id
      name           = vm.name
      ipv4_addresses = vm.ipv4_addresses
      mac_addresses  = vm.mac_addresses
    }
  }
  description = "Provisioned Proxmox VMs keyed by hostname"
}
