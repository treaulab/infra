# Per-account pre-auth key (pilot: burner). Reusable + ephemeral +
# preauthorized, short expiry, single tag. Value flows ONLY into the spoke
# secret below — never committed, never output (see outputs.tf).
#
# Rotation (routine):  tofu taint tailscale_tailnet_key.spoke && tofu apply
#   → new key minted, spoke secret updated in the same apply.
# Revocation (incident): revoke the key in Tailscale admin NOW (fastest),
#   then taint+apply or remove to reconcile state. Other accounts' keys are
#   separate resources — untouched by construction.
#
# State holds the LIVE key (tailscale_tailnet_key.key, sensitive). Local
# state hygiene applies: chmod 600, no copies, gitignored, destroy or
# backend-migrate after learning (see README.md).

resource "tailscale_tailnet_key" "spoke" {
  reusable            = true
  ephemeral           = true
  preauthorized       = true
  expiry              = var.key_expiry_seconds
  tags                = [var.key_tag]
  description         = var.key_description
  recreate_if_invalid = "always"
}
