#!/usr/bin/env bash
# Writes a copy of a deployment record with the blocks scripts/verify-deployment.sh checks: `build` (source commit,
# manifest hash, toolchain), `libraries`, `verifiers` (VK hash, ACIR, verifier source and the expected runtime code
# hash per circuit, plus the getters that wire each one in) and `contracts`. The deploy flow runs it after the
# broadcast, from the manifest of an official scripts/repro-build.sh run at the deployed commit. It reads the chain
# only to tell which compiler profile produced each deployed library.
#
# Usage: scripts/deployment-build-record.sh <record.json> <broadcast.json> <build-dir> <out.json> [--rpc URL] [--allow-unofficial]
#   --allow-unofficial  accept a manifest from a modified tree or another commit (for testing the format only)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd -P)"
[ $# -ge 4 ] || { sed -n '2,9p' "$0" >&2; exit 2; }
RECORD="$1"
BROADCAST="$2"
BUILD_DIR="$3"
OUT="$4"
shift 4
RPC=https://rpc.testnet.chain.robinhood.com
ALLOW_UNOFFICIAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC="$2"; shift 2 ;;
    --allow-unofficial) ALLOW_UNOFFICIAL=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -d "$HOME/.foundry/bin" ]; then PATH="$HOME/.foundry/bin:$PATH"; fi
export PATH

MANIFEST="$BUILD_DIR/manifest.json"
read -r official commit < <(python3 -I -c 'import json, sys; m = json.load(open(sys.argv[1])); print(str(m["official"]).lower(), m["sourceCommit"])' "$MANIFEST")
head="$(git -C "$ROOT" rev-parse HEAD)"
if [ "$ALLOW_UNOFFICIAL" = 0 ]; then
  [ "$official" = true ] || { echo "$MANIFEST isn't official (modified tree or toolchain drift)" >&2; exit 1; }
  [ "$commit" = "$head" ] || { echo "$MANIFEST was built from $commit, HEAD is $head" >&2; exit 1; }
fi
python3 -I "$HERE/repro.py" record --manifest "$MANIFEST" --runtime-dir "$BUILD_DIR/runtime" --rpc "$RPC" \
  --broadcast "$BROADCAST" --record "$RECORD" --out "$OUT"
echo "wrote $OUT"
