terraform {
  required_version = ">= 1.7.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

# Provider credentials are read from environment variable: CLOUDFLARE_API_TOKEN (.envrc loaded by direnv)
# Scoped permissions: Zone -> DNS -> Edit, Zone -> Zone -> Read
provider "cloudflare" {}

# ==============================================================================
# CONFIGURATION
# ==============================================================================
locals {
  zone_name = "treau.me"
}

# ==============================================================================
# DATA SOURCES & RESOURCES
# ==============================================================================

# Resolve the zone once; records and future resources reference this.
# Read-only by design: the zone object itself stays dashboard-owned, so this
# root can never rename/pause/delete the domain by accident.
data "cloudflare_zone" "this" {
  filter = {
    name = local.zone_name
  }
}

# ==============================================================================
# OUTPUTS
# ==============================================================================
output "zone_id" {
  description = "Zone id, needed for imports: tofu import cloudflare_dns_record.X <zone_id>/<record_id>."
  value       = data.cloudflare_zone.this.id
}

output "zone_name" {
  description = "Zone this root manages."
  value       = data.cloudflare_zone.this.name
}
