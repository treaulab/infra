output "zone_id" {
  description = "Zone id, needed for imports: tofu import cloudflare_dns_record.X <zone_id>/<record_id>."
  value       = data.cloudflare_zone.this.id
}

output "zone_name" {
  description = "Zone this root manages."
  value       = data.cloudflare_zone.this.name
}
