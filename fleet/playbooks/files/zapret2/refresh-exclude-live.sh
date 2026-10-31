#!/bin/sh
# refresh-exclude-live.sh
# Refresh the zapret2 "nozapret" exclusion set from the managed domain list
# ipset/zapret-hosts-user-exclude.txt, without reloading firewall rules or
# restarting zapret2. Safe to run while zapret2 is live (root required).
cd "$(dirname "$0")" || exit 1
. ./def.sh || exit 1
. "$ZAPRET_BASE/common/fwtype.sh" || exit 1
. "$ZAPRET_BASE/common/nft.sh" || exit 1

getexclude || exit 1
[ -f "$ZIPLIST_EXCLUDE" ] || { echo "missing $ZIPLIST_EXCLUDE"; exit 1; }

echo "$(date +%F\ %T) refreshing set $ZIPSET_EXCLUDE from $ZIPLIST_EXCLUDE ($(wc -l < "$ZIPLIST_EXCLUDE") IPs)"
nft flush set inet "$ZAPRET_NFT_TABLE" "$ZIPSET_EXCLUDE" || exit 1
while read -r ip; do
  [ -n "$ip" ] || continue
  nft add element inet "$ZAPRET_NFT_TABLE" "$ZIPSET_EXCLUDE" "{ $ip }" || true
done < "$ZIPLIST_EXCLUDE"
echo "$(date +%F\ %T) done"
nft list set inet "$ZAPRET_NFT_TABLE" "$ZIPSET_EXCLUDE" | sed -n '/elements/,$p'
