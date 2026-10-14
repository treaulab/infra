# The tailnet's ENTIRE policy document, managed as code (one ACL doc per
# tailnet — Tailscale policy files are monolithic by design).
#
# SAFETY ORDER (non-negotiable, see README.md):
#   1. Seed policy.json with the CURRENT production policy export first.
#   2. tofu import tailscale_acl.main acl   (adopts, changes nothing)
#   3. tofu plan                            (must show ONLY your additions)
#   4. tofu apply
#
# The provider validates policy (including "tests") against the Tailscale
# API at plan time. Import is enforced by the provider: without it, apply
# fails closed instead of overwriting production.

resource "tailscale_acl" "main" {
  acl = file("${path.module}/${var.policy_file}")
}
