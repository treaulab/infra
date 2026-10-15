#!/usr/bin/env bash
# bump-spoke — pin one spoke caller to a hub SHA (API update, no git push needed).
# Usage:
#   ./scripts/bump-spoke.sh <owner/repo> <hub-sha>
#   ./scripts/bump-spoke.sh andrewwang2161/dotfiles 493398e
#
# Auth: uses the CURRENT gh account (must have Write on the spoke).
# Two burners = run twice, once per account:
#   gh auth switch --user andrewwang2161
#   ./scripts/bump-spoke.sh andrewwang2161/dotfiles <sha>
#   gh auth switch --user <burner2>
#   ./scripts/bump-spoke.sh <burner2>/dotfiles <sha>
# Or per-command without switching: GH_TOKEN="$(gh auth token --user X)" ./scripts/bump-spoke.sh ...
#
# Each spoke keeps its OWN OIDC vars (TS_OIDC_CLIENT_ID/TS_AUDIENCE point at
# that tailnet's federated identity) — this script only bumps the hub pin,
# never touches vars/secrets.
set -euo pipefail
REPO="${1:-}"
HUB_SHA="${2:-}"
[[ -n "$REPO" && -n "$HUB_SHA" ]] || { echo "usage: bump-spoke.sh <owner/repo> <hub-sha>" >&2; exit 1; }
[[ "$HUB_SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "bad hub SHA: $HUB_SHA" >&2; exit 1; }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
TEMPLATE="$ROOT/.github/workflows/tailnet-runner-caller.yml.example"
[[ -f "$TEMPLATE" ]] || { echo "missing $TEMPLATE" >&2; exit 1; }

RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT
sed "s|<PINNED_SHA>|$HUB_SHA|g" "$TEMPLATE" > "$RENDERED"
grep -q "$HUB_SHA" "$RENDERED" || { echo "pin substitution failed" >&2; exit 1; }
grep -q 'vars.TS_OIDC_CLIENT_ID' "$RENDERED" || { echo "template missing OIDC refs" >&2; exit 1; }

FILE_PATH=".github/workflows/tailnet-runner.yml"
if CURRENT_JSON="$(gh api "repos/$REPO/contents/$FILE_PATH" 2>/dev/null)"; then
  CURRENT_SHA="$(echo "$CURRENT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")"
  CURRENT_B64="$(echo "$CURRENT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['content'].replace(chr(10),''))")"
  RENDERED_B64="$(python3 -c "import base64; print(base64.b64encode(open('$RENDERED','rb').read()).decode())")"
  if [[ "$CURRENT_B64" == "$RENDERED_B64" ]]; then
    echo "==> $REPO already pinned to hub $HUB_SHA (no-op)"
    exit 0
  fi
  HAVE_SHA=1
else
  echo "==> $FILE_PATH not in $REPO yet — creating."
  HAVE_SHA=0
fi
MSG="chore: pin hub $HUB_SHA"
if [[ "$HAVE_SHA" == "1" ]]; then
  PAYLOAD="$(python3 -c "
import base64, json
content = open('$RENDERED').read()
print(json.dumps({'message': '$MSG', 'content': base64.b64encode(content.encode()).decode(), 'sha': '$CURRENT_SHA'}))
")"
else
  PAYLOAD="$(python3 -c "
import base64, json
content = open('$RENDERED').read()
print(json.dumps({'message': '$MSG', 'content': base64.b64encode(content.encode()).decode()}))
")"
fi
echo "$PAYLOAD" | gh api -X PUT "repos/$REPO/contents/$FILE_PATH" --input - --jq '{commit: .commit.sha, path: .content.path}'
echo "==> $REPO now pinned to hub $HUB_SHA"
