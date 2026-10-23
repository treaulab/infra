# Auth via ENVIRONMENT ONLY (short-lived admin PAT, never in files):
#   printf 'GitHub admin token: '
#   read -s GITHUB_TOKEN && export GITHUB_TOKEN
#   # or, if the admin account is already authenticated:
#   # read -r GITHUB_TOKEN < <(gh auth token --user <admin-account>) && export GITHUB_TOKEN
# Applies are human, terminal — never CI (see .github/workflows/tofu.yml:
# plan/validate only). No account besides the hub admin ever runs this root.

provider "github" {
  owner = var.owner
}
