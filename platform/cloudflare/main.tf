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
# Scoped permissions: Zone -> DNS -> Edit, Zone -> Zone -> Read, Zone -> Zone Rulesets -> Edit, Zone -> Zone Settings -> Edit, Zone -> Zone WAF -> Edit
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

# --- DNS records (adopted from dashboard, import-first; see README.md) ---------
# All 8 dashboard DNS records for treau.me. `go.treau.me` is a Worker custom
# domain (type `Worker`, content `100::`) in the dashboard — it is NOT a DNS
# record and cannot be managed by cloudflare_dns_record. It stays in
# edge/tunnel-worker (wrangler.toml custom domain) or a Workers API resource.
#
# Import procedure per record (plan must show no changes):
#   tofu import cloudflare_dns_record.apex "<zone_id>/<record_id>"
# Note: names below use the FQDN style the Cloudflare API returns.

resource "cloudflare_dns_record" "apex" {
  zone_id = data.cloudflare_zone.this.id
  name    = "treau.me"
  type    = "A"
  content = "20.98.16.138"
  ttl     = 1 # Auto
  proxied = true
}

resource "cloudflare_dns_record" "www" {
  zone_id = data.cloudflare_zone.this.id
  name    = "www.treau.me"
  type    = "CNAME"
  content = "treau.me"
  ttl     = 1 # Auto
  proxied = true
}

resource "cloudflare_dns_record" "mx1" {
  zone_id  = data.cloudflare_zone.this.id
  name     = "treau.me"
  type     = "MX"
  content  = "route1.mx.cloudflare.net"
  priority = 23
  ttl      = 1 # Auto
  proxied  = false
}

resource "cloudflare_dns_record" "mx2" {
  zone_id  = data.cloudflare_zone.this.id
  name     = "treau.me"
  type     = "MX"
  content  = "route2.mx.cloudflare.net"
  priority = 49
  ttl      = 1 # Auto
  proxied  = false
}

resource "cloudflare_dns_record" "mx3" {
  zone_id  = data.cloudflare_zone.this.id
  name     = "treau.me"
  type     = "MX"
  content  = "route3.mx.cloudflare.net"
  priority = 66
  ttl      = 1 # Auto
  proxied  = false
}

resource "cloudflare_dns_record" "dkim" {
  zone_id = data.cloudflare_zone.this.id
  name    = "cf2024-1._domainkey.treau.me"
  type    = "TXT"
  content = "\"v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiweykoi+o48IOGuP7GR3X0MOExCUDY/BCRHoWBnh3rChl7WhdyCxW3jgq1daEjPPqoi7sJvdg5hEQVsgVRQP4DcnQDVjGMbASQtrY4WmB1VebF+RPJB2ECPsEDTpeiI5ZyUAwJaVX7r6bznU67g7LvFq35yIo4sdlmtZGV+i0H4cpYH9+3JJ78k\" \"m4KXwaf9xUJCWF6nxeD+qG6Fyruw1Qlbds2r85U9dkNDVAS3gioCvELryh1TxKGiVTkg4wqHTyHfWsp7KD3WQHYJn0RyfJJu6YEmL77zonn7p2SRMvTMP3ZEXibnC9gz3nnhR6wcYL8Q7zXypKTMD58bTixDSJwIDAQAB\""
  ttl     = 1 # Auto
  proxied = false
}

resource "cloudflare_dns_record" "google_verification" {
  zone_id = data.cloudflare_zone.this.id
  name    = "treau.me"
  type    = "TXT"
  content = "\"google-site-verification=-FnWcghllztv6SodLMY7C8xWi-6SMlhPbgtI3n-UlJw\""
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "spf" {
  zone_id = data.cloudflare_zone.this.id
  name    = "treau.me"
  type    = "TXT"
  content = "\"v=spf1 include:_spf.mx.cloudflare.net ~all\""
  ttl     = 1 # Auto
  proxied = false
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = data.cloudflare_zone.this.id
  name    = "_dmarc.treau.me"
  type    = "TXT"
  content = "\"v=DMARC1; p=none; sp=quarantine; rua=mailto:dmarc@treau.me\""
  ttl     = 1 # Auto
  proxied = false
}

# --- Edge Redirects (Ruleset Engine / Single Redirects) -----------------------
# Cloudflare maintains one zone entrypoint ruleset for http_request_dynamic_redirect.
# Existing dashboard rules (Yomi, Good Music) are adopted here alongside
# the www to apex redirect, keeping traffic off the Azure VPS origin.
resource "cloudflare_ruleset" "redirects" {
  zone_id     = data.cloudflare_zone.this.id
  name        = "default"
  description = ""
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [
    {
      action      = "redirect"
      description = "Yomi"
      enabled     = true
      expression  = "(http.request.full_uri wildcard r\"http*://*treau.me/supersecretproject*\")"
      action_parameters = {
        from_value = {
          preserve_query_string = false
          status_code           = 301
          target_url = {
            expression = "wildcard_replace(http.request.full_uri, r\"http*://*treau.me/supersecretproject*\", r\"https://yomihon.github.io/\")"
          }
        }
      }
    },
    {
      action      = "redirect"
      description = "Good Music"
      enabled     = true
      expression  = "(http.request.full_uri wildcard r\"https://*treau.me/goodmusic\")"
      action_parameters = {
        from_value = {
          preserve_query_string = false
          status_code           = 301
          target_url = {
            expression = "wildcard_replace(http.request.full_uri, r\"https://*treau.me/goodmusic\", r\"https://music.youtube.com/playlist?list=PLVVHpb_v9Gr4\")"
          }
        }
      }
    },
    {
      action      = "redirect"
      description = "Redirect www to apex"
      enabled     = true
      expression  = "http.host eq \"www.treau.me\""
      action_parameters = {
        from_value = {
          preserve_query_string = true
          status_code           = 301
          target_url = {
            expression = "concat(\"https://treau.me\", http.request.uri.path)"
          }
        }
      }
    }
  ]
}

# --- Zone Settings (TLS & Security Baseline) ----------------------------------
# Enforces end-to-end cryptographic verification to Azure Caddy origin,
# upgrades plaintext HTTP at the edge, and removes deprecated TLS versions.
resource "cloudflare_zone_setting" "ssl" {
  zone_id    = data.cloudflare_zone.this.id
  setting_id = "ssl"
  value      = "strict"
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = data.cloudflare_zone.this.id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = data.cloudflare_zone.this.id
  setting_id = "min_tls_version"
  value      = "1.2"
}

resource "cloudflare_zone_setting" "security_header" {
  zone_id    = data.cloudflare_zone.this.id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = 31536000
      include_subdomains = true
      nosniff            = true
      preload            = false
    }
  }
}

# --- Edge WAF & Scanner Blocking ----------------------------------------------
# Drops automated vulnerability scanners (.env, .git, WordPress/PHP probes)
# and challenges high-threat visitors before traffic hits the Azure Caddy origin.
resource "cloudflare_ruleset" "custom_waf" {
  zone_id     = data.cloudflare_zone.this.id
  name        = "default"
  description = "Zone-level custom WAF ruleset"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      action      = "block"
      description = "Block vulnerability and environment file probes"
      enabled     = true
      expression  = "(http.request.uri.path contains \"/.env\" or http.request.uri.path contains \"/.git\" or http.request.uri.path contains \"/wp-\" or http.request.uri.path contains \"/xmlrpc.php\" or http.request.uri.path contains \"/phpmyadmin\")"
    },
    {
      action      = "managed_challenge"
      description = "Managed challenge for high threat reputation score"
      enabled     = true
      expression  = "(cf.threat_score gt 14)"
    }
  ]
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
