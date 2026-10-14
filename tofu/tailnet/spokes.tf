# Spoke-side delivery: the minted key lands in the hand-created spoke
# repo's Actions secret, which the caller workflow reads at runtime.
#
# Trust direction (explicit): the GITHUB_TOKEN identity (slancj) must hold
# Write on the spoke repo — granted ONCE by the spoke owner as collaborator,
# revocable there at any time (revoking breaks future rotations only; live
# runs keep working till the key itself is revoked). IaC never creates,
# owns, or deletes spoke repos: they are data of human ownership.
# (data source omitted deliberately — a missing repo fails fast at apply
# with a clear GitHub 404; fewer moving parts for a learning root.)
#
# Value comes from the key RESOURCE (never committed, never pasted) — the
# pattern the provider docs recommend. State holds it: see hygiene note
# in keys.tf. Account #3: add an aliased github provider (owner = that
# account) + a copy of this block pinned to it (documented in README.md).

resource "github_actions_secret" "spoke_key" {
  repository  = var.spoke_repo
  secret_name = var.spoke_secret_name
  value       = tailscale_tailnet_key.spoke.key
}
