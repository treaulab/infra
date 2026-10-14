# Both providers authenticate via ENVIRONMENT ONLY — no tokens in code,
# tfvars, or state inputs. Bootstrap ceremony (once, human, short-lived):
#
#   # PRIMARY: OAuth client credentials (you hold client ID + secret).
#   # Client needs scopes: auth_keys + policy_file + devices:core:read +
#   # devices:posture_attributes, tags including tag:ci-ephemeral, shortest
#   # expiry. The provider mints short-lived access tokens itself.
#   export TAILSCALE_OAUTH_CLIENT_ID="k12345..."
#   export TAILSCALE_OAUTH_CLIENT_SECRET="tskey-client-..."
#   export TAILSCALE_TAILNET="you@example.com"  # your tailnet name
#   # FALLBACK: a pre-minted OAuth access token instead of the pair above
#   # (conflicts with the pair — use one path, not both):
#   # export TAILSCALE_API_KEY="tskey-api-..."
#   export GITHUB_TOKEN="$(gh auth token)"      # admin PAT (repo scope) of an
#                                       # account with Write on the spoke repo
#                                       # (slancj as spoke collaborator).
#
# All credentials are short-lived by policy: re-mint, never store.

provider "tailscale" {}

provider "github" {
  # Spoke repos live under per-account owners (pilot: andrewwang2161).
  # One owner per provider config: account #3 adds an aliased block
  # (see README.md). Never point this at an account you don't administer.
  owner = var.spoke_owner
}
