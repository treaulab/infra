variable "owner" {
  description = "GitHub org or user owning the repo."
  type        = string
  default     = "treaulab"
}

variable "repository" {
  description = "Repo name (not full_name) under owner."
  type        = string
  default     = "infra"
}

variable "pattern" {
  description = "Branch pattern to protect."
  type        = string
  default     = "main"
}

variable "required_approvals" {
  description = "Approvals required on PRs (non-admin authors). Solo-operator note: admin bypass below means your own merges are unaffected until enforce_admins is flipped."
  type        = number
  default     = 1
}

variable "enforce_admins" {
  description = "Enroll admins in the same rules. false = pragmatic start (your direct-push flow keeps working; non-admin Write like burner is still gated). Flip to true when ready for full PR-only discipline (see README.md)."
  type        = bool
  default     = false
}
