# platform/azure

Azure VPS: resource group lookup/create, VNet, subnet, NSG, public IP, NIC,
and the Ubuntu 24.04 VM. This root is the former `tofu/` root; state is local
and gitignored.

```bash
# Credentials from environment (ARM_SUBSCRIPTION_ID, etc.) or configured in locals of main.tf
tofu init
tofu plan
```

The VM is the public website origin only. Caddy on it serves static files;
it does not proxy homelab services. Applies are human-run.
