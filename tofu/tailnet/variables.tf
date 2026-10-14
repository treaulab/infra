variable "spoke_owner" {
  description = "GitHub login owning the spoke repo (pilot: burner account). Must have granted the GITHUB_TOKEN identity Write on the spoke repo."
  type        = string
  default     = "andrewwang2161"
}

variable "spoke_repo" {
  description = "Spoke repo name (hand-created by the account owner BEFORE first apply; IaC never creates/deletes repos)."
  type        = string
  default     = "tailnet-shell"
}

variable "spoke_secret_name" {
  description = "Actions secret name the spoke caller workflow reads."
  type        = string
  default     = "TS_AUTHKEY_EPHEMERAL"
}

variable "key_tag" {
  description = "Tailscale tag applied to nodes joining with this key (must exist in tagOwners in policy.json)."
  type        = string
  default     = "tag:ci-ephemeral"
}

variable "key_expiry_seconds" {
  description = "Key lifetime in seconds (default 30d). Short = safer; rotation is one taint+apply."
  type        = number
  default     = 2592000
}

variable "key_description" {
  description = "Human note stored on the key in Tailscale admin (alphanumeric)."
  type        = string
  default     = "tailnet-shell hourly runner burner"
}

variable "policy_file" {
  description = "Policy (HuJSON) file managed as the tailnet's entire policy document."
  type        = string
  default     = "policy.json"
}
