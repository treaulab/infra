# Auth via ENVIRONMENT ONLY (short-lived admin PAT, never in files):
#   export GITHUB_TOKEN="$(gh auth token)"   # slancj admin session.
# Applies are human, terminal — never CI (see .github/workflows/tofu.yml:
# plan/validate only). No account besides the hub admin ever runs this root.

provider "github" {
  owner = var.owner
}
