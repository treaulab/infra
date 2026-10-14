# Both providers authenticate via ENVIRONMENT ONLY — no tokens in code,
# tfvars, or state inputs. Bootstrap ceremony (once, human, short-lived):
#
#   export TAILSCALE_API_KEY="$(...)"   # OAuth access token (minted from a
#                                       # scoped, expiring OAuth client in
#                                       # Tailscale admin). Least privilege:
#                                       # auth-keys write + policy write.
#   export TAILSCALE_TAILNET="you@example.com"  # your tailnet name
#   export GITHUB_TOKEN="$(gh auth token)"      # admin PAT (repo scope) of an
#                                       # account with Write on the spoke repo
#                                       # (slancj as spoke collaborator).
#
# All three are short-lived by policy: re-mint, never store.

provider "tailscale" {}

provider "github" {
  # Spoke repos live under per-account owners (pilot: andrewwang2161).
  # One owner per provider config: account #3 adds an aliased block
  # (see README.md). Never point this at an account you don't administer.
  owner = var.spoke_owner
}
