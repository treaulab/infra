#!/usr/bin/env python3
"""
Syncs required classroom lab DNS zones and A records to MamaDuck (192.168.10.5).
Idempotently ensures forward lookup zones and records exist in Windows Server DNS.
"""

import subprocess
import base64
import os
import sys

PS_SCRIPT = """
$ErrorActionPreference = 'SilentlyContinue'

function Ensure-Zone ($zoneName) {
    $existing = Get-DnsServerZone -Name $zoneName
    if (-not $existing) {
        Write-Host "Creating DNS Zone: $zoneName"
        Add-DnsServerPrimaryZone -Name $zoneName -ZoneFile "$zoneName.dns"
    } else {
        Write-Host "Zone $zoneName already exists."
    }
}

function Ensure-ARecord ($zoneName, $name, $ip) {
    $existing = Get-DnsServerResourceRecord -ZoneName $zoneName -Name $name -RRType A
    if (-not $existing) {
        Write-Host "Adding Record: $name.$zoneName -> $ip"
        Add-DnsServerResourceRecordA -ZoneName $zoneName -Name $name -IPv4Address $ip
    } else {
        Write-Host "Record $name.$zoneName ($ip) already exists."
    }
}

# 1. class.net zone (Short clean classroom domain)
Ensure-Zone "class.net"
Ensure-ARecord "class.net" "@" "192.168.10.77"
Ensure-ARecord "class.net" "*" "192.168.10.77"

# 2. class single-label domain
Ensure-Zone "class"
Ensure-ARecord "class" "@" "192.168.10.77"
Ensure-ARecord "class" "*" "192.168.10.77"

# 3. lan zone
Ensure-Zone "lan"
Ensure-ARecord "lan" "@" "192.168.10.77"
Ensure-ARecord "lan" "class" "192.168.10.77"
Ensure-ARecord "lan" "*" "192.168.10.77"

# 4. duckling.local Active Directory zone
Ensure-ARecord "duckling.local" "class" "192.168.10.77"
Ensure-ARecord "duckling.local" "status" "192.168.10.77"
Ensure-ARecord "duckling.local" "exam" "192.168.10.70"

# 5. ctf.com override zone
Ensure-Zone "ctf.com"
Ensure-ARecord "ctf.com" "duckling" "192.168.10.76"

Write-Host "DNS Sync Complete."
"""

def main():
    askpass = os.path.expanduser("/home/trueking/.gemini/antigravity-cli/brain/a500d51b-618e-40b4-91e1-e85c24bdb265/scratch/askpass.sh")
    pass_file = os.path.expanduser("~/Safe/pass.txt")
    
    # If askpass doesn't exist, create temporary one from ~/Safe/pass.txt
    if not os.path.isfile(askpass) and os.path.isfile(pass_file):
        with open(pass_file) as f:
            pw = f.read().strip()
        askpass = "/tmp/askpass_dns.sh"
        with open(askpass, "w") as f:
            f.write(f'#!/bin/sh\necho "{pw}"\n')
        os.chmod(askpass, 0o700)

    encoded = base64.b64encode(PS_SCRIPT.encode('utf-16le')).decode('ascii')
    env = os.environ.copy()
    env["SSH_ASKPASS_REQUIRE"] = "force"
    env["SSH_ASKPASS"] = askpass

    cmd = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "PubkeyAuthentication=no",
        "svc-mgmt@192.168.10.5",
        f"powershell -NoProfile -EncodedCommand {encoded}"
    ]

    print("Syncing DNS zones and records to MamaDuck (192.168.10.5)...")
    res = subprocess.run(cmd, env=env, text=True, capture_output=True)
    print(res.stdout)
    if res.returncode != 0:
        print("ERROR:", res.stderr, file=sys.stderr)
        sys.exit(res.returncode)

if __name__ == "__main__":
    main()
