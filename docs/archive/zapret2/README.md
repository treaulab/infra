# zapret2 Archive & Reproduction Guide

This archive preserves the standalone and Kubernetes-native DPI circumvention setup using `zapret2` (`nfqws2`), so it can be 100% reproduced or redeployed if needed in the future.

> [!NOTE]
> In production, DPI circumvention is handled at the network level by OpenWrt (`192.168.10.254`) as a transparent gateway proxy. This directory is archived for disaster recovery or running standalone DPI circumvention on individual hosts/clusters.

---

## Components

- **`Dockerfile`**: Multi-stage build that compiles `nfqws2` from source on Debian Bookworm and packages a minimal runtime (~35MB) with `nftables`.
- **`entrypoint.sh`**: Auto-detects the host's WAN interface, configures `nftables` queue (QNUM 300), starts `zapret2`, and handles clean shutdown signals (SIGTERM/SIGINT) to flush nftables tables.
- **`zapret2.yaml`**: Declarative Kubernetes DaemonSet manifest running in the `zapret2` namespace with `hostNetwork: true` and `NET_ADMIN`/`NET_RAW` capabilities.
- **`zapret2-image.yml`**: GitHub Actions workflow that builds multi-arch (`linux/amd64`, `linux/arm64`) images and pushes to GHCR (`ghcr.io/treaulab/infra/zapret2:latest`).

---

## How to Reproduce / Redeploy

### Option A: Kubernetes DaemonSet (Recommended for Clusters)

1. **Deploy the manifest**:
   ```bash
   kubectl apply -f zapret2.yaml
   ```
2. **Verify pods are running on all nodes**:
   ```bash
   kubectl get pods -n zapret2 -o wide
   ```
3. **Verify nftables rules on any host**:
   ```bash
   sudo nft list table inet zapret2
   ```

### Option B: Standalone Docker / Docker Compose

You can also run the container on any single host without Kubernetes:

```bash
docker run -d \
  --name zapret2 \
  --restart unless-stopped \
  --network host \
  --cap-add NET_ADMIN \
  --cap-add NET_RAW \
  ghcr.io/treaulab/infra/zapret2:latest
```

---

## Configuration Reference

The proven desync strategy configured in `zapret2.yaml`:
```text
NFQWS2_OPT="--filter-tcp=443 --in-range=-s1 --lua-desync=oob:urp=midsld:char=a"
```
This forces Out-Of-Band (OOB) urgent-pointer desynchronization on middle-domain SNIs, effectively bypassing TSPU / Russian ISP DPI packet inspection.
