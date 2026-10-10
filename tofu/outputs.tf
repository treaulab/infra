output "public_ip" {
  value       = azurerm_public_ip.main.ip_address
  description = "Point <domain> A-record here"
}

output "resource_group" {
  value = local.rg_name
}

output "nsg_id" {
  value = azurerm_network_security_group.main.id
}
