variable "zone_name" {
  description = "Apex zone this root manages. One zone per root/state; a second domain gets its own root."
  type        = string
  default     = "treau.me"
}
