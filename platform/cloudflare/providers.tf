# Auth via ENVIRONMENT ONLY — never in code, tfvars, or state inputs:
#
#   export CLOUDFLARE_API_TOKEN="..."
#   # or paste a short-lived token straight into the terminal env (never a file)
#
# Token: dedicated to this root, scoped to the single zone, least privilege:
#   Zone → DNS  → Edit   (manage records)
#   Zone → Zone → Read   (resolve the zone id from its name)
# Add permissions only when a phase needs them (Zone Settings → Edit,
# Email Routing → Edit). Do NOT reuse the account-scoped CI token from
# tunnel.yml — separate purpose, separate blast radius. This is a standing
# token: keyring/Bitwarden or another password manager (runbooks.md §Secrets),
# never committed, never pasted into chat.

provider "cloudflare" {}
