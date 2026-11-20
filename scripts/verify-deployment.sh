#!/usr/bin/env bash
# Checks a deployment record against the chain without sending a transaction. It rebuilds the record's source commit
# with scripts/repro-build.sh and requires the same manifest hash, then compares every library, verifier and protocol
# contract's code with link and immutable slots masked, reads $VK_HASH, $LOG_N and the other immutables out of each
# verifier, checks the library links, and calls the protocol getters that wire verifiers in. RPC calls are
# eth_chainId, eth_getCode and eth_call only.
#
# Usage: scripts/verify-deployment.sh <record.json> [--rpc URL] [--docker] [--build-dir DIR]
#   --rpc URL        JSON-RPC endpoint (default: Robinhood Chain testnet for chain 46630)
#   --docker         rebuild in the linux-amd64 reference image (zk/Dockerfile.repro)
#   --build-dir DIR  skip the rebuild and use an existing repro-build.sh output; its manifest must still match
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd -P)"
[ $# -ge 1 ] || { sed -n '2,12p' "$0" >&2; exit 2; }
RECORD="$1"
shift
RPC=""
DOCKER=()
BUILD_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC="$2"; shift 2 ;;
    --docker) DOCKER=(--docker); shift ;;
    --build-dir) BUILD_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -d "$HOME/.foundry/bin" ]; then PATH="$HOME/.foundry/bin:$PATH"; fi
export PATH

field() {
  python3 -I -c '
import json, sys
v = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    v = v.get(k, "") if isinstance(v, dict) else ""
print(v)' "$RECORD" "$1"
}
chain="$(field chainId)"
if [ -z "$RPC" ]; then
  case "$chain" in
    46630) RPC=https://rpc.testnet.chain.robinhood.com ;;
    *) echo "no default RPC for chain $chain; pass --rpc" >&2; exit 2 ;;
  esac
fi

commit="$(field build.sourceCommit)"
if [ -z "$commit" ]; then
  exec python3 -I "$HERE/repro.py" verify --record "$RECORD" --manifest /dev/null --rpc "$RPC"
fi

if [ -z "$BUILD_DIR" ]; then
  git -C "$ROOT" cat-file -e "$commit^{commit}" 2>/dev/null || { echo "$commit isn't in this clone; git fetch the deployment tag first" >&2; exit 1; }
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/rooq-verify.XXXXXX")"
  trap 'rm -rf -- "$TMP"' EXIT
  mkdir -p "$TMP/src"
  git -C "$ROOT" archive "$commit" | tar -xf - -C "$TMP/src"
  while read -r _ type sha path; do
    if [ "$type" = commit ]; then
      mkdir -p "$TMP/src/$path"
      git -C "$ROOT/$path" archive "$sha" | tar -xf - -C "$TMP/src/$path"
    fi
  done < <(git -C "$ROOT" ls-tree -r "$commit")
  [ -f "$TMP/src/scripts/repro-build.sh" ] || { echo "$commit predates scripts/repro-build.sh" >&2; exit 1; }
  echo "== rebuilding $commit"
  "$TMP/src/scripts/repro-build.sh" --src "$TMP/src" --commit "$commit" --out "$TMP/out" ${DOCKER[@]+"${DOCKER[@]}"}
  BUILD_DIR="$TMP/out"
fi

echo "== checking $RECORD against $RPC"
python3 -I "$HERE/repro.py" verify --record "$RECORD" --manifest "$BUILD_DIR/manifest.json" --rpc "$RPC"
