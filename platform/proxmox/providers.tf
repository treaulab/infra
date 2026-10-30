# Auth via ENVIRONMENT ONLY (.envrc loaded by direnv or shell env) — never in code, tfvars, or state inputs:
#
#   export PROXMOX_VE_ENDPOINT="https://192.168.1.100:8006/"
#   export PROXMOX_VE_API_TOKEN="terraform@pve!token=00000000-0000-0000-0000-000000000000"
#   export PROXMOX_VE_INSECURE="true"
#
# bpg/proxmox natively reads PROXMOX_VE_ENDPOINT, PROXMOX_VE_API_TOKEN,
# and PROXMOX_VE_INSECURE from the environment.

provider "proxmox" {}
