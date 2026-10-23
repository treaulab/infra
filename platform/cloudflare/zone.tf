# Resolve the zone once; records and future resources reference this.
# Read-only by design: the zone object itself stays dashboard-owned, so this
# root can never rename/pause/delete the domain by accident.
data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}
