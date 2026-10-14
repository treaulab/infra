# Metadata ONLY. Never output secret/key values: outputs render in console
# and CI logs. Key expiry is safe to expose (scheduling signal for rotation).

output "key_id" {
  description = "Tailscale ID of the spoke key (for admin cross-reference / import)."
  value       = tailscale_tailnet_key.spoke.id
}

output "key_expires_at" {
  description = "RFC3339 expiry of the spoke key — rotate before this (taint + apply)."
  value       = tailscale_tailnet_key.spoke.expires_at
}

output "spoke_secret" {
  description = "Where the key was delivered (owner/repo:secret), for runbook cross-check."
  value       = "${var.spoke_owner}/${var.spoke_repo}:${var.spoke_secret_name}"
}
