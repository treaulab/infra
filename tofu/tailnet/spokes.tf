# Spoke-side delivery: minted key(s) land in the hand-created PUBLIC spoke
# repo's per-tenant Environment secrets, which the matrix caller reads at
# runtime (same secret NAME per environment, distinct values).
#
# Trust direction (explicit): the GITHUB_TOKEN identity (slancj) holds Write
# on the spoke repo ONLY inside grant windows — invited before apply,
# REVOKED immediately after (re-grant ~30s per rotation). No standing
# cross-account edge. Revoking breaks future rotations only; live runs keep
# working till the key itself is revoked. IaC never creates, owns, or
# deletes the spoke repo: it is data of human ownership.
# (A missing repo fails fast at apply with a clear GitHub 404.)
#
# Value comes from the key RESOURCE (never committed, never pasted) — the
# pattern the provider docs recommend. State holds it: see hygiene note
# in keys.tf. Tenant #2: copy the key block (own tag) + a copy of the
# secret block below with a distinct secret_name — same provider, same
# repo (full pattern in tenants.tf.example).

resource "github_actions_secret" "spoke_key" {
  repository  = var.spoke_repo
  secret_name = var.spoke_secret_name
  value       = tailscale_tailnet_key.spoke.key
}
